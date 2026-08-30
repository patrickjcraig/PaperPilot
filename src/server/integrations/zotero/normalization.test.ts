import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeZoteroItemForSync,
  sanitizeZoteroMetadata,
  zoteroContentHash,
} from "./normalization";
import { toZoteroVersion } from "./protocol";

test("metadata sanitization removes note and annotation bodies without mutating input", () => {
  const source = {
    itemType: "note",
    note: "<p>private note body</p>",
    annotationText: "selected text",
    annotationComment: "private comment",
    title: "Retained metadata",
  };
  const sanitized = sanitizeZoteroMetadata(source);
  assert.deepEqual(sanitized, {
    itemType: "note",
    title: "Retained metadata",
  });
  assert.equal(source.note, "<p>private note body</p>");
  assert.doesNotMatch(JSON.stringify(sanitized), /private|selected text/);
});

test("metadata sanitization never retains a linked-file path", () => {
  const source = {
    itemType: "attachment",
    linkMode: "linked_file",
    contentType: "application/pdf",
    filename: "paper.pdf",
    path: "C:\\Users\\researcher\\Private Study\\paper.pdf",
  };

  const sanitized = sanitizeZoteroMetadata(source);

  assert.deepEqual(sanitized, {
    itemType: "attachment",
    linkMode: "linked_file",
    contentType: "application/pdf",
    filename: "paper.pdf",
  });
  assert.equal(source.path, "C:\\Users\\researcher\\Private Study\\paper.pdf");
  assert.doesNotMatch(JSON.stringify(sanitized), /Users|Private Study/);
});

test("content hashes are deterministic across object key order", () => {
  assert.equal(
    zoteroContentHash({ b: [2, 3], a: { y: true, x: null } }),
    zoteroContentHash({ a: { x: null, y: true }, b: [2, 3] }),
  );
  assert.notEqual(
    zoteroContentHash({ a: 1 }),
    zoteroContentHash({ a: 2 }),
  );
});

test("bibliographic items become bounded Zotero inbox snapshots", () => {
  const normalized = normalizeZoteroItemForSync({
    library: { kind: "group", id: "42" },
    retrievedAt: "2026-08-28T12:00:00.000Z",
    item: {
      key: "ABC12345",
      version: toZoteroVersion("900719925474099300"),
      data: {
        itemType: "conferencePaper",
        title: "A durable synchronization method",
        creators: [
          { creatorType: "editor", firstName: "Ignored", lastName: "Editor" },
          { creatorType: "author", firstName: "Ada", lastName: "Lovelace" },
          { creatorType: "author", name: "Research Consortium" },
        ],
        date: "2025-04-12",
        proceedingsTitle: "Proceedings of Reliable Systems",
        abstractNote: "A provider-grounded abstract.",
        DOI: "https://doi.org/10.1234/EXAMPLE.7",
        ISBN: "978-1-4028-9462-6",
        url: "https://example.test/paper",
        tags: [{ tag: "sync" }, { tag: "sync" }, { tag: "provenance" }],
        dateModified: "2026-08-20T10:00:00Z",
        note: "must not persist",
      },
    },
  });

  assert.equal(normalized.parentKey, undefined);
  assert.equal(normalized.data.note, undefined);
  assert.match(normalized.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(normalized.inboxSnapshot);
  assert.equal(normalized.inboxSnapshot.paper.type, "conference paper");
  assert.deepEqual(normalized.inboxSnapshot.paper.authors, [
    "Ada Lovelace",
    "Research Consortium",
  ]);
  assert.equal(normalized.inboxSnapshot.paper.year, 2025);
  assert.deepEqual(normalized.inboxSnapshot.paper.identifiers, [
    { scheme: "doi", value: "10.1234/example.7" },
    { scheme: "isbn", value: "9781402894626" },
    {
      scheme: "provider",
      value: "zotero:group:42:item:ABC12345",
    },
  ]);
  assert.equal(normalized.inboxSnapshot.provenance.accessMethod, "oauth");
  assert.equal(
    normalized.inboxSnapshot.provenance.version,
    "900719925474099300",
  );
  assert.doesNotMatch(JSON.stringify(normalized), /must not persist/);
});

test("attachments, notes, annotations, and child items never become paper inbox rows", () => {
  for (const [itemType, extra] of [
    ["attachment", { title: "Attachment metadata" }],
    ["note", { title: "Note title", note: "body" }],
    ["annotation", { title: "Annotation", annotationText: "body" }],
    ["journalArticle", { title: "Child record", parentItem: "PARENT12" }],
  ] as const) {
    const normalized = normalizeZoteroItemForSync({
      library: { kind: "user", id: "7" },
      retrievedAt: "2026-08-28T12:00:00.000Z",
      item: {
        key: "ZXCV1234",
        version: toZoteroVersion("3"),
        data: { itemType, ...extra },
      },
    });
    assert.equal(normalized.inboxSnapshot, undefined);
  }
});
