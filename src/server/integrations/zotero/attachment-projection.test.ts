import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ZOTERO_ATTACHMENT_INELIGIBLE_REASON_CODES,
  ZOTERO_ATTACHMENT_LINK_MODES,
  ZOTERO_ATTACHMENT_MALFORMED_REASON_CODES,
  projectZoteroAttachment,
} from "./attachment-projection";

const MD5 = "0123456789abcdef0123456789abcdef";

function storedAttachment(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    itemType: "attachment",
    linkMode: "imported_file",
    contentType: "application/pdf",
    filename: "paper.pdf",
    md5: MD5,
    ...overrides,
  };
}

describe("Zotero attachment metadata projection", () => {
  it("admits a stored PDF with canonical identity and normalized optional fields", () => {
    assert.deepEqual(
      projectZoteroAttachment({
        objectType: "ITEM",
        data: storedAttachment({
          filename: "Cafe\u0301.PDF",
          mtime: 1_775_000_123_456,
          parentItem: " abc12345 ",
        }),
      }),
      {
        outcome: "downloadable",
        candidate: {
          objectType: "ITEM",
          linkMode: "imported_file",
          contentType: "application/pdf",
          filename: "Café.PDF",
          md5: MD5,
          mtime: "1775000123456",
          parentItem: "ABC12345",
        },
      },
    );
  });

  it("preserves a top-level imported-url attachment without inventing a parent", () => {
    const projected = projectZoteroAttachment({
      objectType: "ITEM",
      data: storedAttachment({ linkMode: "imported_url" }),
    });

    assert.equal(projected.outcome, "downloadable");
    if (projected.outcome !== "downloadable") return;
    assert.equal(projected.candidate.linkMode, "imported_url");
    assert.equal("parentItem" in projected.candidate, false);
    assert.equal("mtime" in projected.candidate, false);
  });

  it("normalizes Zotero's explicit parentItem false as a top-level attachment", () => {
    const projected = projectZoteroAttachment({
      objectType: "ITEM",
      data: storedAttachment({ parentItem: false }),
    });

    assert.equal(projected.outcome, "downloadable");
    if (projected.outcome !== "downloadable") return;
    assert.equal("parentItem" in projected.candidate, false);
  });

  it("normalizes a canonical decimal-string mtime without numeric coercion", () => {
    const projected = projectZoteroAttachment({
      objectType: "ITEM",
      data: storedAttachment({ mtime: "1775000123456" }),
    });

    assert.equal(projected.outcome, "downloadable");
    if (projected.outcome !== "downloadable") return;
    assert.equal(projected.candidate.mtime, "1775000123456");
  });

  it("recognizes every closed link mode but refuses non-stored attachments", () => {
    assert.deepEqual(ZOTERO_ATTACHMENT_LINK_MODES, [
      "imported_file",
      "imported_url",
      "linked_file",
      "linked_url",
      "embedded_image",
    ]);

    for (const [linkMode, reasonCode] of [
      ["linked_file", "linked_file_not_downloadable"],
      ["linked_url", "linked_url_not_downloadable"],
      ["embedded_image", "embedded_image_not_downloadable"],
    ] as const) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ linkMode }),
        }),
        { outcome: "ineligible", reasonCode },
      );
    }
  });

  it("keeps attachments in the ITEM namespace and rejects other source objects", () => {
    assert.deepEqual(
      projectZoteroAttachment({
        objectType: "COLLECTION",
        data: storedAttachment(),
      }),
      { outcome: "ineligible", reasonCode: "source_not_item" },
    );
    assert.deepEqual(
      projectZoteroAttachment({
        objectType: "ITEM",
        data: { itemType: "journalArticle" },
      }),
      { outcome: "ineligible", reasonCode: "item_not_attachment" },
    );
  });

  it("fails closed on malformed metadata and unknown link modes", () => {
    for (const data of [null, [], "attachment"] as const) {
      assert.deepEqual(
        projectZoteroAttachment({ objectType: "ITEM", data }),
        { outcome: "malformed", reasonCode: "invalid_metadata" },
      );
    }
    for (const linkMode of [undefined, null, ""] as const) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ linkMode }),
        }),
        { outcome: "malformed", reasonCode: "invalid_link_mode" },
      );
    }
    assert.deepEqual(
      projectZoteroAttachment({
        objectType: "ITEM",
        data: storedAttachment({ linkMode: "future_provider_mode" }),
      }),
      { outcome: "ineligible", reasonCode: "unsupported_link_mode" },
    );
  });

  it("requires the exact PDF media type and an uncompressed-looking PDF name", () => {
    for (const contentType of [
      "Application/PDF",
      "application/pdf; charset=binary",
      "application/octet-stream",
    ]) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ contentType }),
        }),
        { outcome: "ineligible", reasonCode: "content_type_not_pdf" },
      );
    }
    for (const contentType of [undefined, null, 42] as const) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ contentType }),
        }),
        { outcome: "malformed", reasonCode: "invalid_content_type" },
      );
    }
    for (const filename of ["paper", "paper.zip", "paper.pdf.gz"] as const) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ filename }),
        }),
        { outcome: "ineligible", reasonCode: "filename_not_pdf" },
      );
    }
  });

  it("rejects unsafe or unbounded display filenames", () => {
    for (const filename of [
      undefined,
      "../paper.pdf",
      "C:\\private\\paper.pdf",
      "paper\u202Efdp.exe.pdf",
      `${"a".repeat(252)}.pdf`,
    ] as const) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ filename }),
        }),
        { outcome: "malformed", reasonCode: "invalid_filename" },
      );
    }
  });

  it("requires a canonical lower-case MD5 without coercion", () => {
    for (const md5 of [
      undefined,
      null,
      MD5.toUpperCase(),
      ` ${MD5}`,
      MD5.slice(0, -1),
      "g".repeat(32),
    ] as const) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ md5 }),
        }),
        { outcome: "malformed", reasonCode: "invalid_md5" },
      );
    }
  });

  it("accepts only safe integer mtime values and canonicalizable parent keys", () => {
    for (const mtime of [
      null,
      "",
      "01",
      "+1",
      "1.0",
      String(Number.MAX_SAFE_INTEGER + 1),
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ mtime }),
        }),
        { outcome: "malformed", reasonCode: "invalid_mtime" },
      );
    }
    for (const parentItem of [
      null,
      true,
      0,
      "",
      "TOO-SHORT",
      "ABCDEFGHI",
    ] as const) {
      assert.deepEqual(
        projectZoteroAttachment({
          objectType: "ITEM",
          data: storedAttachment({ parentItem }),
        }),
        { outcome: "malformed", reasonCode: "invalid_parent_item" },
      );
    }
  });

  it("publishes closed, duplicate-free reason-code sets", () => {
    assert.equal(
      new Set(ZOTERO_ATTACHMENT_INELIGIBLE_REASON_CODES).size,
      ZOTERO_ATTACHMENT_INELIGIBLE_REASON_CODES.length,
    );
    assert.equal(
      new Set(ZOTERO_ATTACHMENT_MALFORMED_REASON_CODES).size,
      ZOTERO_ATTACHMENT_MALFORMED_REASON_CODES.length,
    );
    for (const code of ZOTERO_ATTACHMENT_INELIGIBLE_REASON_CODES) {
      assert.equal(ZOTERO_ATTACHMENT_MALFORMED_REASON_CODES.includes(
        code as never,
      ), false);
    }
  });
});
