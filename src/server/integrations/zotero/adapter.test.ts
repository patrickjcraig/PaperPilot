import assert from "node:assert/strict";
import test from "node:test";

import { ZoteroReadOnlyAdapter } from "./adapter";
import { ZoteroAdapterError } from "./errors";
import { toZoteroVersion } from "./protocol";

const CONNECTION = {
  organizationId: "workspace-a",
  connectionId: "connection-a",
} as const;

function groupFixture(id = 12345, version = 7) {
  return {
    id,
    version,
    links: { self: { href: `https://api.zotero.org/groups/${id}` } },
    meta: { numItems: 3 },
    data: {
      id,
      version,
      name: `Research Group ${id}`,
      type: "Private",
      libraryReading: "members",
      libraryEditing: "admins",
      fileEditing: "none",
      members: [42],
    },
  };
}

function itemFixture(key = "ABCD1234", version = 8) {
  return {
    key,
    version,
    library: { type: "user", id: 42 },
    links: { self: { href: `https://api.zotero.org/users/42/items/${key}` } },
    meta: { numChildren: 0 },
    data: {
      key,
      version,
      itemType: "journalArticle",
      title: "Grounded systems",
      note: "Provider content remains raw at this boundary.",
    },
  };
}

function collectionFixture(key = "COLL1234", version = 9) {
  return {
    key,
    version,
    data: {
      key,
      version,
      name: "Reading queue",
      parentCollection: false,
    },
  };
}

test("credential resolution is bound to the authorized workspace and connection", async () => {
  const lookups: Array<{ organizationId: string; connectionId: string }> = [];
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async (lookup) => {
      lookups.push(lookup);
      return { accessToken: "test-access-token" };
    },
    fetchImpl: async () => new Response(JSON.stringify({
      userID: 42,
      username: "researcher",
      access: { user: { library: true } },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });

  const response = await adapter.getCurrentIdentity({
    organizationId: "workspace-a",
    connectionId: "connection-a",
  });
  assert.equal(response.data.userId, "42");
  assert.deepEqual(lookups, [{
    organizationId: "workspace-a",
    connectionId: "connection-a",
  }]);
});

test("group discovery returns strict provider metadata and preserves page throttles", async () => {
  let requestedUrl = "";
  let requestHeaders: Headers | undefined;
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => ({ accessToken: "test-access-token" }),
    now: () => new Date("2026-08-28T18:00:00.000Z"),
    fetchImpl: async (url, init) => {
      requestedUrl = url.toString();
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify([groupFixture()]), {
        status: 200,
        headers: {
          "Total-Results": "2",
          Link: '<https://api.zotero.org/users/42/groups?limit=1&start=1>; rel="next"',
          Backoff: "12",
          "Retry-After": "30",
        },
      });
    },
  });

  const response = await adapter.listUserGroups({
    ...CONNECTION,
    userId: "42",
    start: 0,
    limit: 1,
  });
  assert.equal(response.outcome, "data");
  assert.equal(
    requestedUrl,
    "https://api.zotero.org/users/42/groups?format=json&limit=1&start=0",
  );
  assert.equal(requestHeaders?.get("authorization"), "Bearer test-access-token");
  assert.equal(response.data[0]?.id, "12345");
  assert.equal(response.data[0]?.name, "Research Group 12345");
  assert.equal(response.data[0]?.libraryEditing, "admins");
  assert.deepEqual(response.data[0]?.data.members, [42]);
  assert.equal(response.meta.totalResults, 2);
  assert.equal(response.meta.backoffSeconds, 12);
  assert.equal(response.meta.retryAfterSeconds, 30);
  assert.equal(response.meta.retryAt, "2026-08-28T18:00:30.000Z");
  assert.equal(
    response.meta.nextPageUrl,
    "https://api.zotero.org/users/42/groups?limit=1&start=1",
  );
});

test("group discovery rejects malformed groups, duplicates, and pagination chains", async () => {
  const malformedCases: Array<{
    body: unknown;
    headers?: Record<string, string>;
  }> = [
    { body: {}, headers: { "Total-Results": "0" } },
    {
      body: [{ ...groupFixture(), id: 0 }],
      headers: { "Total-Results": "1" },
    },
    {
      body: [{ ...groupFixture(), data: { ...groupFixture().data, version: 8 } }],
      headers: { "Total-Results": "1" },
    },
    {
      body: [{ ...groupFixture(), data: { ...groupFixture().data, libraryReading: "world" } }],
      headers: { "Total-Results": "1" },
    },
    {
      body: [groupFixture(), groupFixture()],
      headers: { "Total-Results": "2" },
    },
    {
      body: [groupFixture()],
      headers: {
        "Total-Results": "2",
        Link: '<https://api.zotero.org/users/42/items?limit=1&start=1>; rel="next"',
      },
    },
    {
      body: [groupFixture()],
      headers: { "Total-Results": "2" },
    },
    {
      body: [],
      headers: {
        "Total-Results": "2",
        Link: '<https://api.zotero.org/users/42/groups?limit=1&start=1>; rel="next"',
      },
    },
  ];

  for (const entry of malformedCases) {
    const adapter = new ZoteroReadOnlyAdapter({
      credentialResolver: async () => ({ accessToken: "test-access-token" }),
      fetchImpl: async () => new Response(JSON.stringify(entry.body), {
        status: 200,
        headers: entry.headers,
      }),
    });
    await assert.rejects(
      () => adapter.listUserGroups({ ...CONNECTION, userId: "42", limit: 1 }),
      (error: unknown) =>
        error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
    );
  }
});

test("version manifests use opaque cursors, preserve stable-version headers, and model 304", async () => {
  const requests: Array<{ url: string; headers: Headers }> = [];
  let call = 0;
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => ({ accessToken: "test-access-token" }),
    now: () => new Date("2026-08-28T18:00:00.000Z"),
    fetchImpl: async (url, init) => {
      requests.push({ url: url.toString(), headers: new Headers(init?.headers) });
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ ABCD1234: 11, EFGH5678: "12" }), {
          status: 200,
          headers: {
            "Last-Modified-Version": "9223372036854775808",
            Backoff: "9",
          },
        });
      }
      return new Response(null, {
        status: 304,
        headers: { Backoff: "5", "Retry-After": "10" },
      });
    },
  });

  const itemManifest = await adapter.listLibraryItemVersions({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    sinceVersion: toZoteroVersion("900719925474099312345"),
  });
  assert.equal(itemManifest.outcome, "data");
  if (itemManifest.outcome === "data") {
    assert.deepEqual(itemManifest.data, { ABCD1234: "11", EFGH5678: "12" });
    assert.equal(itemManifest.meta.libraryVersion, "9223372036854775808");
    assert.equal(itemManifest.meta.backoffSeconds, 9);
  }
  assert.equal(
    requests[0]?.url,
    "https://api.zotero.org/users/42/items?format=versions&since=900719925474099312345&includeTrashed=1",
  );

  const collectionManifest = await adapter.listLibraryCollectionVersions({
    ...CONNECTION,
    library: { kind: "group", id: "99" },
    sinceVersion: toZoteroVersion("12"),
    ifModifiedSinceVersion: toZoteroVersion("12"),
  });
  assert.equal(collectionManifest.outcome, "not_modified");
  assert.equal(collectionManifest.data, null);
  assert.equal(collectionManifest.meta.providerStatus, 304);
  assert.equal(collectionManifest.meta.backoffSeconds, 5);
  assert.equal(collectionManifest.meta.retryAfterSeconds, 10);
  assert.equal(requests[1]?.headers.get("if-modified-since-version"), "12");
  assert.equal(
    requests[1]?.url,
    "https://api.zotero.org/groups/99/collections?format=versions&since=12",
  );
});

test("manifests reject malformed keys, versions, shapes, missing version headers, and unsolicited 304", async () => {
  const cases: Array<{ body: unknown; headers?: Record<string, string>; status?: number }> = [
    { body: [], headers: { "Last-Modified-Version": "1" } },
    { body: { short: 1 }, headers: { "Last-Modified-Version": "1" } },
    { body: { ABCD1234: -1 }, headers: { "Last-Modified-Version": "1" } },
    { body: { ABCD1234: 1 } },
    { body: null, status: 304 },
  ];
  for (const entry of cases) {
    const adapter = new ZoteroReadOnlyAdapter({
      credentialResolver: async () => ({ accessToken: "test-access-token" }),
      fetchImpl: async () => entry.status === 304
        ? new Response(null, { status: 304, headers: entry.headers })
        : new Response(JSON.stringify(entry.body), {
            status: entry.status ?? 200,
            headers: entry.headers,
          }),
    });
    await assert.rejects(
      () => adapter.listLibraryItemVersions({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        sinceVersion: toZoteroVersion("0"),
      }),
      (error: unknown) =>
        error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
    );
  }
});

test("item and collection body batches are bounded, include trashed items, and retain raw data", async () => {
  const urls: string[] = [];
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => ({ accessToken: "test-access-token" }),
    fetchImpl: async (url) => {
      urls.push(url.toString());
      const isCollection = new URL(url.toString()).pathname.endsWith("/collections");
      return new Response(JSON.stringify([
        isCollection ? collectionFixture() : itemFixture(),
      ]), {
        status: 200,
        headers: {
          "Last-Modified-Version": isCollection ? "19" : "18",
          Backoff: isCollection ? "4" : "3",
        },
      });
    },
  });

  const items = await adapter.getLibraryItemsByKeys({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    itemKeys: ["abcd1234"],
  });
  assert.equal(items.data[0]?.data.note, "Provider content remains raw at this boundary.");
  assert.equal(items.meta.libraryVersion, "18");
  assert.equal(items.meta.backoffSeconds, 3);
  const itemUrl = new URL(urls[0] ?? "");
  assert.equal(itemUrl.searchParams.get("includeTrashed"), "1");
  assert.equal(itemUrl.searchParams.get("itemKey"), "ABCD1234");
  assert.equal(itemUrl.searchParams.get("limit"), "1");

  const collections = await adapter.getLibraryCollectionsByKeys({
    ...CONNECTION,
    library: { kind: "group", id: "99" },
    collectionKeys: ["coll1234"],
  });
  assert.equal(collections.data[0]?.key, "COLL1234");
  assert.equal(collections.meta.libraryVersion, "19");
  const collectionUrl = new URL(urls[1] ?? "");
  assert.equal(collectionUrl.searchParams.get("collectionKey"), "COLL1234");
  assert.equal(collectionUrl.searchParams.has("includeTrashed"), false);
});

test("body batches reject inconsistent identities, duplicates, and unrequested provider objects", async () => {
  const bodies = [
    [{ ...itemFixture(), data: { ...itemFixture().data, key: "OTHER123" } }],
    [itemFixture(), itemFixture()],
    [itemFixture("OTHER123")],
  ];
  for (const body of bodies) {
    const adapter = new ZoteroReadOnlyAdapter({
      credentialResolver: async () => ({ accessToken: "test-access-token" }),
      fetchImpl: async () => new Response(JSON.stringify(body), {
        headers: { "Last-Modified-Version": "18" },
      }),
    });
    await assert.rejects(
      () => adapter.getLibraryItemsByKeys({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        itemKeys: ["ABCD1234"],
      }),
      (error: unknown) =>
        error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
    );
  }

  const collectionAdapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => ({ accessToken: "test-access-token" }),
    fetchImpl: async () => new Response(JSON.stringify([{
      ...collectionFixture(),
      data: { ...collectionFixture().data, version: 10 },
    }]), { headers: { "Last-Modified-Version": "19" } }),
  });
  await assert.rejects(
    () => collectionAdapter.getLibraryCollectionsByKeys({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      collectionKeys: ["COLL1234"],
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
  );
});

test("deletion manifests retain item and collection tombstones and ignore future categories", async () => {
  let requestedUrl = "";
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => ({ accessToken: "test-access-token" }),
    now: () => new Date("2026-08-28T18:00:00.000Z"),
    fetchImpl: async (url) => {
      requestedUrl = url.toString();
      return new Response(JSON.stringify({
        collections: ["COLL1234"],
        items: ["ABCD1234"],
        searches: ["SRCH1234"],
        tags: ["priority"],
        settings: ["future-compatible"],
      }), {
        headers: {
          "Last-Modified-Version": "20",
          Backoff: "15",
          "Retry-After": "20",
        },
      });
    },
  });

  const response = await adapter.getLibraryDeletions({
    ...CONNECTION,
    library: { kind: "group", id: "99" },
    sinceVersion: toZoteroVersion("12"),
  });
  assert.equal(response.outcome, "data");
  if (response.outcome === "data") {
    assert.deepEqual(response.data, {
      collections: ["COLL1234"],
      items: ["ABCD1234"],
      searches: ["SRCH1234"],
      tags: ["priority"],
    });
  }
  assert.equal(requestedUrl, "https://api.zotero.org/groups/99/deleted?since=12");
  assert.equal(response.meta.libraryVersion, "20");
  assert.equal(response.meta.backoffSeconds, 15);
  assert.equal(response.meta.retryAfterSeconds, 20);
});

test("deletion manifests fail closed on missing arrays, malformed keys, tags, and duplicates", async () => {
  const valid = {
    collections: [] as string[],
    items: [] as string[],
    searches: [] as string[],
    tags: [] as string[],
  };
  const malformed = [
    { ...valid, collections: undefined },
    { ...valid, items: ["short"] },
    { ...valid, searches: ["SRCH1234", "SRCH1234"] },
    { ...valid, tags: [""] },
  ];
  for (const body of malformed) {
    const adapter = new ZoteroReadOnlyAdapter({
      credentialResolver: async () => ({ accessToken: "test-access-token" }),
      fetchImpl: async () => new Response(JSON.stringify(body), {
        headers: { "Last-Modified-Version": "20" },
      }),
    });
    await assert.rejects(
      () => adapter.getLibraryDeletions({
        ...CONNECTION,
        library: { kind: "group", id: "99" },
        sinceVersion: toZoteroVersion("12"),
      }),
      (error: unknown) =>
        error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
    );
  }
});

test("403 distinguishes invalid connection identity from a library ACL failure", async () => {
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => ({ accessToken: "test-access-token" }),
    fetchImpl: async () => new Response(null, { status: 403 }),
  });
  await assert.rejects(
    () => adapter.getCurrentIdentity(CONNECTION),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_authentication_failed"
      && error.providerStatus === 403,
  );
  await assert.rejects(
    () => adapter.listLibraryItems({
      ...CONNECTION,
      library: { kind: "group", id: "99" },
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_forbidden"
      && error.providerStatus === 403,
  );
});

test("oversized provider bodies are terminal resource-limit inputs", async () => {
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => ({ accessToken: "test-access-token" }),
    maxResponseBytes: 8,
    fetchImpl: async () => new Response("123456789", {
      headers: { "Content-Length": "9" },
    }),
  });
  await assert.rejects(
    () => adapter.listLibraryItems({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_response_too_large"
      && error.retryable === false,
  );
});

test("invalid workspace context fails before credentials or fetch are touched", async () => {
  let resolverCalled = false;
  let fetchCalled = false;
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => {
      resolverCalled = true;
      return { accessToken: "test-access-token" };
    },
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response("{}");
    },
  });

  await assert.rejects(
    adapter.getCurrentIdentity({
      organizationId: "workspace-a\r\nforeign",
      connectionId: "connection-a",
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_invalid_request",
  );
  assert.equal(resolverCalled, false);
  assert.equal(fetchCalled, false);
});

test("identity verification bounds declared and streamed bodies and rejects invalid UTF-8", async () => {
  const cases: Array<() => Response> = [
    () => new Response("{}", { headers: { "Content-Length": "1025" } }),
    () => new Response(new Uint8Array(1025)),
    () => new Response(Uint8Array.from([0xff, 0xfe, 0xfd])),
  ];

  for (const [index, response] of cases.entries()) {
    const adapter = new ZoteroReadOnlyAdapter({
      credentialResolver: async () => ({ accessToken: "test-access-token" }),
      fetchImpl: async () => response(),
      maxResponseBytes: 1024,
    });
    await assert.rejects(
      () => adapter.getCurrentIdentity({
        organizationId: "workspace-a",
        connectionId: "connection-a",
      }),
      (error: unknown) =>
        error instanceof ZoteroAdapterError
        && error.code === (index < 2
          ? "zotero_response_too_large"
          : "zotero_bad_response"),
    );
  }
});

test("identity verification timeout remains active while the response body streams", async () => {
  let aborted = false;
  const adapter = new ZoteroReadOnlyAdapter({
    credentialResolver: async () => ({ accessToken: "test-access-token" }),
    timeoutMs: 10,
    fetchImpl: async (_url, init) => {
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener("abort", () => {
            aborted = true;
            controller.error(new DOMException("aborted", "AbortError"));
          }, { once: true });
        },
      });
      return new Response(body, { status: 200 });
    },
  });

  await assert.rejects(
    () => adapter.getCurrentIdentity({
      organizationId: "workspace-a",
      connectionId: "connection-a",
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_timeout"
      && error.status === 504,
  );
  assert.equal(aborted, true);
});

test("identity verification rejects a redirected or mismatched final provider URL", async () => {
  for (const responseProperties of [
    { redirected: true, url: "https://api.zotero.org/keys/current" },
    { redirected: false, url: "https://api.zotero.org/keys/other" },
    { redirected: false, url: "https://attacker.example/keys/current" },
  ]) {
    const adapter = new ZoteroReadOnlyAdapter({
      credentialResolver: async () => ({ accessToken: "test-access-token" }),
      fetchImpl: async () => {
        const response = new Response("{}");
        Object.defineProperties(response, {
          redirected: { value: responseProperties.redirected },
          url: { value: responseProperties.url },
        });
        return response;
      },
    });
    await assert.rejects(
      () => adapter.getCurrentIdentity({
        organizationId: "workspace-a",
        connectionId: "connection-a",
      }),
      (error: unknown) =>
        error instanceof ZoteroAdapterError && error.code === "zotero_unavailable",
    );
  }
});
