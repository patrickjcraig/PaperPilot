import assert from "node:assert/strict";
import test from "node:test";
import { ZOTERO_API_VERSION } from "./contracts";
import { ZoteroAdapterError } from "./errors";
import {
  ZOTERO_API_ORIGIN,
  assertZoteroApiUrl,
  assertZoteroGroupNextPageUrl,
  buildZoteroLibraryCollectionBatchUrl,
  buildZoteroLibraryCollectionVersionsUrl,
  buildZoteroLibraryDeletedUrl,
  buildZoteroLibraryItemBatchUrl,
  buildZoteroLibraryItemsUrl,
  buildZoteroLibraryItemVersionsUrl,
  buildZoteroRequestHeaders,
  buildZoteroUserGroupsUrl,
  chunkZoteroCollectionKeys,
  chunkZoteroItemKeys,
  normalizeZoteroCollectionKeys,
  normalizeZoteroItemKeys,
  parseZoteroNextLink,
  parseZoteroResponseHeaders,
  toZoteroVersion,
} from "./protocol";

function makeKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    index.toString(36).toUpperCase().padStart(8, "0"),
  );
}

test("library item URLs are pinned to Zotero and encode bounded read parameters", () => {
  const url = buildZoteroLibraryItemsUrl({
    library: { kind: "group", id: "12345" },
    sinceVersion: toZoteroVersion("900719925474099312345"),
    start: 200,
    limit: 100,
    itemKeys: ["abcd1234", "EFGH5678"],
  });

  assert.equal(url.origin, ZOTERO_API_ORIGIN);
  assert.equal(url.pathname, "/groups/12345/items");
  assert.equal(url.searchParams.get("format"), "json");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("start"), "200");
  assert.equal(url.searchParams.get("since"), "900719925474099312345");
  assert.equal(url.searchParams.get("itemKey"), "ABCD1234,EFGH5678");
});

test("group, version-manifest, batch, and deletion URLs are exact and provider bounded", () => {
  const groups = buildZoteroUserGroupsUrl({
    userId: "42",
    start: 100,
    limit: 100,
  });
  assert.equal(
    groups.toString(),
    "https://api.zotero.org/users/42/groups?format=json&limit=100&start=100",
  );

  const itemVersions = buildZoteroLibraryItemVersionsUrl({
    library: { kind: "user", id: "42" },
    sinceVersion: toZoteroVersion("9223372036854775808"),
  });
  assert.equal(itemVersions.pathname, "/users/42/items");
  assert.equal(itemVersions.searchParams.get("format"), "versions");
  assert.equal(itemVersions.searchParams.get("since"), "9223372036854775808");
  assert.equal(itemVersions.searchParams.get("includeTrashed"), "1");
  assert.equal(itemVersions.searchParams.has("limit"), false);

  const collectionVersions = buildZoteroLibraryCollectionVersionsUrl({
    library: { kind: "group", id: "99" },
    sinceVersion: toZoteroVersion("0"),
  });
  assert.equal(
    collectionVersions.toString(),
    "https://api.zotero.org/groups/99/collections?format=versions&since=0",
  );

  const items = buildZoteroLibraryItemBatchUrl({
    library: { kind: "group", id: "99" },
    itemKeys: ["abcd1234", "EFGH5678"],
  });
  assert.equal(items.searchParams.get("itemKey"), "ABCD1234,EFGH5678");
  assert.equal(items.searchParams.get("includeTrashed"), "1");
  assert.equal(items.searchParams.get("limit"), "2");

  const collections = buildZoteroLibraryCollectionBatchUrl({
    library: { kind: "user", id: "42" },
    collectionKeys: ["abcd1234"],
  });
  assert.equal(collections.searchParams.get("collectionKey"), "ABCD1234");
  assert.equal(collections.searchParams.get("limit"), "1");
  assert.equal(collections.searchParams.has("includeTrashed"), false);

  const deleted = buildZoteroLibraryDeletedUrl({
    library: { kind: "group", id: "99" },
    sinceVersion: toZoteroVersion("18"),
  });
  assert.equal(deleted.toString(), "https://api.zotero.org/groups/99/deleted?since=18");
});

test("group pagination accepts only the same endpoint and exact next offset", () => {
  const current = buildZoteroUserGroupsUrl({ userId: "42", start: 0, limit: 25 });
  assert.equal(
    assertZoteroGroupNextPageUrl(
      current,
      "https://api.zotero.org/users/42/groups?limit=25&start=25",
    ),
    "https://api.zotero.org/users/42/groups?limit=25&start=25",
  );

  for (const next of [
    "https://api.zotero.org/users/43/groups?limit=25&start=25",
    "https://api.zotero.org/users/42/items?limit=25&start=25",
    "https://api.zotero.org/users/42/groups?limit=25&start=50",
    "https://api.zotero.org/users/42/groups?limit=100&start=25",
    "https://api.zotero.org/users/42/groups?limit=25&start=25&key=secret",
    "https://api.zotero.org/users/42/groups?limit=25&limit=25&start=25",
  ]) {
    assert.throws(() => assertZoteroGroupNextPageUrl(current, next));
  }
});

test("invalid library IDs and pagination bounds fail before a URL can escape", () => {
  assert.throws(
    () =>
      buildZoteroLibraryItemsUrl({
        library: { kind: "user", id: "//evil.example/path" },
      }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError && error.code === "zotero_invalid_request",
  );
  assert.throws(
    () =>
      buildZoteroLibraryItemsUrl({
        library: { kind: "user", id: "123" },
        limit: 101,
      }),
    /between 1 and 100/,
  );
  assert.throws(
    () =>
      buildZoteroLibraryItemsUrl({
        library: { kind: "user", id: "123" },
        start: -1,
      }),
    /non-negative safe integer/,
  );
  assert.throws(
    () => buildZoteroUserGroupsUrl({ userId: "0" }),
    /positive decimal integer/,
  );
  assert.throws(
    () => buildZoteroUserGroupsUrl({ userId: "42", limit: 101 }),
    /between 1 and 100/,
  );
  assert.throws(
    () =>
      buildZoteroLibraryItemBatchUrl({
        library: { kind: "user", id: "42" },
        itemKeys: [],
      }),
    /at least one item key/,
  );
  assert.throws(
    () =>
      buildZoteroLibraryCollectionBatchUrl({
        library: { kind: "user", id: "42" },
        collectionKeys: makeKeys(51),
      }),
    /at most 50 collection keys/,
  );
});

test("provider next links must resolve to the exact Zotero HTTPS API origin", () => {
  const sameOrigin = parseZoteroNextLink(
    '<https://api.zotero.org/users/12/items?start=100&limit=100>; rel="next", <https://api.zotero.org/users/12/items?start=0>; rel="first"',
  );
  assert.equal(
    sameOrigin,
    "https://api.zotero.org/users/12/items?start=100&limit=100",
  );
  assert.equal(
    parseZoteroNextLink('</groups/9/items?start=100>; rel="next prev"'),
    "https://api.zotero.org/groups/9/items?start=100",
  );

  assert.throws(
    () => parseZoteroNextLink('<https://api.zotero.org.evil.example/items>; rel="next"'),
    /outside the trusted API origin/,
  );
  assert.throws(
    () => assertZoteroApiUrl("http://api.zotero.org/users/12/items"),
    /outside the trusted API origin/,
  );
  assert.throws(
    () => assertZoteroApiUrl("https://token@api.zotero.org/users/12/items"),
    /outside the trusted API origin/,
  );
  assert.throws(
    () => assertZoteroApiUrl("https://api.zotero.org/users/12/items#fragment"),
    /outside the trusted API origin/,
  );
  assert.throws(
    () => parseZoteroNextLink(
      '<https://api.zotero.org/users/12/items?start=100>; rel="next", '
      + '<https://api.zotero.org/users/12/items?start=200>; rel="next"',
    ),
    /more than one next/,
  );
});

test("Zotero response headers preserve sync, throttle, total, and next-page metadata", () => {
  const now = new Date("2026-08-28T18:00:00.000Z");
  const headers = new Headers({
    "Last-Modified-Version": "9223372036854775808",
    Backoff: "120",
    "Retry-After": "Fri, 28 Aug 2026 18:01:30 GMT",
    "Total-Results": "241",
    Link: '<https://api.zotero.org/users/12/items?start=100>; rel="next"',
  });

  const metadata = parseZoteroResponseHeaders(headers, now, 429);
  assert.equal(metadata.providerStatus, 429);
  assert.equal(metadata.libraryVersion, "9223372036854775808");
  assert.equal(metadata.backoffSeconds, 120);
  assert.equal(metadata.retryAfterSeconds, 90);
  assert.equal(metadata.retryAt, "2026-08-28T18:01:30.000Z");
  assert.equal(metadata.totalResults, 241);
  assert.equal(
    metadata.nextPageUrl,
    "https://api.zotero.org/users/12/items?start=100",
  );
});

test("request headers enforce API v3 and bearer authorization without query credentials", () => {
  const headers = buildZoteroRequestHeaders("  secret-token  ", {
    ifModifiedSinceVersion: toZoteroVersion("9223372036854775808"),
  });
  assert.equal(headers.get("authorization"), "Bearer secret-token");
  assert.equal(headers.get("zotero-api-version"), ZOTERO_API_VERSION);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(
    headers.get("if-modified-since-version"),
    "9223372036854775808",
  );
  assert.throws(
    () => buildZoteroRequestHeaders("unsafe\r\ntoken"),
    (error: unknown) =>
      error instanceof ZoteroAdapterError &&
      error.code === "zotero_credential_unavailable",
  );
});

test("key batches never exceed Zotero's 50-key provider limit", () => {
  const fifty = makeKeys(50);
  assert.equal(normalizeZoteroItemKeys(fifty).length, 50);
  assert.throws(() => normalizeZoteroItemKeys(makeKeys(51)), /at most 50/);

  const batches = chunkZoteroItemKeys(makeKeys(103));
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [50, 50, 3],
  );
  assert.ok(batches.every((batch) => batch.length <= 50));

  assert.equal(normalizeZoteroCollectionKeys(fifty).length, 50);
  assert.throws(() => normalizeZoteroCollectionKeys(makeKeys(51)), /at most 50/);
  assert.deepEqual(
    chunkZoteroCollectionKeys(makeKeys(101)).map((batch) => batch.length),
    [50, 50, 1],
  );
});

test("malformed provider protocol headers fail closed", () => {
  assert.throws(
    () =>
      parseZoteroResponseHeaders(
        new Headers({ "Last-Modified-Version": "12.5" }),
        new Date("2026-08-28T18:00:00.000Z"),
      ),
    /invalid Last-Modified-Version/,
  );
  assert.throws(
    () =>
      parseZoteroResponseHeaders(
        new Headers({ "Total-Results": "Infinity" }),
        new Date("2026-08-28T18:00:00.000Z"),
      ),
    /invalid total-results/i,
  );
  assert.throws(
    () =>
      parseZoteroResponseHeaders(
        new Headers({ "Retry-After": String(Number.MAX_SAFE_INTEGER) }),
        new Date("2026-08-28T18:00:00.000Z"),
      ),
    /out-of-range Retry-After/,
  );
});
