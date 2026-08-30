import assert from "node:assert/strict";
import test from "node:test";

import {
  ZoteroAttachmentBinaryAdapter,
  parseStrongZoteroAttachmentEtag,
  type ZoteroAttachmentBinaryAdapterOptions,
  type ZoteroAttachmentBlobAllowlistEntry,
} from "./attachment-binary-adapter";
import { ZoteroAdapterError } from "./errors";

const CONNECTION = {
  organizationId: "workspace-a",
  connectionId: "connection-a",
} as const;
const FILE_MD5 = "bfa4b10a76324b166cfdad5e02a63730";
const FILE_BYTES = new TextEncoder().encode("%PDF");
const DIRECT_BLOB_ORIGIN = "https://files.example";
const SIGNED_LOCATION =
  `${DIRECT_BLOB_ORIGIN}/objects/${FILE_MD5}?X-Amz-Signature=super-secret`;

function apiRedirect(
  location = SIGNED_LOCATION,
  overrides: Record<string, string | undefined> = {},
): Response {
  const headers: Record<string, string> = {
    Location: location,
    "Zotero-File-MD5": FILE_MD5,
    "Zotero-File-Size": String(FILE_BYTES.byteLength),
    "Zotero-File-Compressed": "No",
    "Zotero-File-Modification-Time": "1788019200123",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Response(null, { status: 302, headers });
}

function blobResponse(
  bytes: Uint8Array = FILE_BYTES,
  overrides: Record<string, string | undefined> = {},
  status = 200,
): Response {
  const headers: Record<string, string> = {
    "Content-Length": String(FILE_BYTES.byteLength),
    "Content-Type": "application/pdf",
    ETag: `"${FILE_MD5}"`,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  const responseBytes = new Uint8Array(bytes.byteLength);
  responseBytes.set(bytes);
  return new Response(responseBytes.buffer, { status, headers });
}

function adapter(
  fetchImpl: typeof fetch,
  overrides: Partial<ZoteroAttachmentBinaryAdapterOptions> = {},
  blobAllowlist: readonly ZoteroAttachmentBlobAllowlistEntry[] = [
    { kind: "exact-origin", origin: DIRECT_BLOB_ORIGIN },
  ],
): ZoteroAttachmentBinaryAdapter {
  const fetchWithResponseMetadata: typeof fetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    if (!response.url) {
      Object.defineProperty(response, "url", {
        configurable: true,
        value: input.toString(),
      });
    }
    return response;
  };
  return new ZoteroAttachmentBinaryAdapter({
    credentialResolver: async () => ({ accessToken: "server-resolved-key" }),
    fetchImpl: fetchWithResponseMetadata,
    blobAllowlist,
    ...overrides,
  });
}

async function readBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(body).arrayBuffer());
}

test("downloads through one authenticated API redirect and a credential-free blob hop", async () => {
  const lookups: unknown[] = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = adapter(async (input, init) => {
    requests.push({ url: input.toString(), init });
    return requests.length === 1
      ? apiRedirect(SIGNED_LOCATION, {
          Backoff: "11",
          "Retry-After": "17",
        })
      : blobResponse();
  }, {
    credentialResolver: async (lookup) => {
      lookups.push(lookup);
      return { accessToken: "server-resolved-key" };
    },
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });

  const download = await client.downloadAttachment({
    ...CONNECTION,
    library: { kind: "group", id: "99" },
    itemKey: "abcd1234",
    maximumBytes: 25 * 1_024 * 1_024,
  });

  assert.deepEqual(lookups, [CONNECTION]);
  assert.equal(
    requests[0]?.url,
    "https://api.zotero.org/groups/99/items/ABCD1234/file",
  );
  const apiHeaders = new Headers(requests[0]?.init?.headers);
  assert.equal(apiHeaders.get("authorization"), "Bearer server-resolved-key");
  assert.equal(apiHeaders.get("zotero-api-version"), "3");
  assert.equal(apiHeaders.get("accept-encoding"), "identity");
  assert.equal(requests[0]?.init?.redirect, "manual");
  assert.equal(requests[0]?.init?.credentials, "omit");
  assert.equal(requests[0]?.init?.referrerPolicy, "no-referrer");

  assert.equal(requests[1]?.url, SIGNED_LOCATION);
  const blobHeaders = new Headers(requests[1]?.init?.headers);
  assert.equal(blobHeaders.get("authorization"), null);
  assert.equal(blobHeaders.get("zotero-api-key"), null);
  assert.equal(blobHeaders.get("zotero-api-version"), null);
  assert.equal(blobHeaders.get("cookie"), null);
  assert.equal(blobHeaders.get("referer"), null);
  assert.deepEqual(Array.from(blobHeaders.keys()).sort(), [
    "accept",
    "accept-encoding",
  ]);
  assert.equal(requests[1]?.init?.redirect, "manual");
  assert.equal(requests[1]?.init?.credentials, "omit");
  assert.equal(requests[1]?.init?.referrerPolicy, "no-referrer");

  assert.deepEqual(download.file, {
    md5: FILE_MD5,
    sizeBytes: 4,
    compressed: false,
    modificationTimeMilliseconds: "1788019200123",
  });
  assert.equal(download.contentLength, 4);
  assert.equal(download.contentType, "application/pdf");
  assert.equal(download.etagMd5, FILE_MD5);
  assert.deepEqual(download.meta, {
    retrievedAt: "2026-08-29T12:00:00.000Z",
    apiStatus: 302,
    blobStatus: 200,
    backoffSeconds: 11,
    retryAfterSeconds: 17,
    retryAt: "2026-08-29T12:00:17.000Z",
  });
  assert.deepEqual(await readBytes(download.body), FILE_BYTES);
  assert.deepEqual(await download.integrity, {
    md5: FILE_MD5,
    sizeBytes: FILE_BYTES.byteLength,
  });
  assert.equal("location" in download, false);
  assert.equal(JSON.stringify(download).includes("super-secret"), false);
});

test("accepts an explicitly scoped legacy S3 path-style bucket", async () => {
  const legacyLocation =
    "https://s3.amazonaws.com/zotero-files/001122/file.pdf"
    + "?X-Amz-Credential=key%2Fdate%2Fregion%2Fs3%2Faws4_request";
  let calls = 0;
  const client = adapter(async () => {
    calls += 1;
    return calls === 1 ? apiRedirect(legacyLocation) : blobResponse();
  }, {}, [{
    kind: "s3-path-style",
    origin: "https://s3.amazonaws.com",
    bucket: "zotero-files",
  }]);

  const download = await client.downloadAttachment({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    itemKey: "ABCD1234",
    maximumBytes: 100,
  });
  assert.deepEqual(await readBytes(download.body), FILE_BYTES);
  assert.equal(calls, 2);
});

test("rejects untrusted or ambiguous signed redirect locations before the blob hop", async () => {
  const unsafeLocations = [
    "http://files.example/objects/file",
    "https://files.example:8443/objects/file",
    "https://user:password@files.example/objects/file",
    "https://files.example/objects/file#fragment",
    "https://attacker.example/objects/file",
    "https://files.example/objects/a%2Ffile",
    "https://files.example/objects/a%5cfile",
    "https://files.example/objects/../file",
    "https://files.example/objects/%2e%2e/file",
    "https://files.example//objects/file",
    "https://files.example\\@attacker.example/objects/file",
    "https://files.example/objects/file,https://attacker.example/file",
  ];

  for (const location of unsafeLocations) {
    let calls = 0;
    const client = adapter(async () => {
      calls += 1;
      return apiRedirect(location);
    });
    await assert.rejects(
      () => client.downloadAttachment({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        itemKey: "ABCD1234",
        maximumBytes: 100,
      }),
      (error: unknown) =>
        error instanceof ZoteroAdapterError
        && error.code === "zotero_bad_response",
      location,
    );
    assert.equal(calls, 1, location);
  }
});

test("path-style S3 rules cannot escape or ambiguously spell the configured bucket", async () => {
  const locations = [
    "https://s3.amazonaws.com/another-bucket/hash/file.pdf?sig=1",
    "https://s3.amazonaws.com/%7aotero-files/hash/file.pdf?sig=1",
    "https://s3.amazonaws.com/zotero-files%2Fother/hash/file.pdf?sig=1",
    "https://s3.amazonaws.com/zotero-files/../other/file.pdf?sig=1",
  ];
  for (const location of locations) {
    let calls = 0;
    const client = adapter(async () => {
      calls += 1;
      return apiRedirect(location);
    }, {}, [{
      kind: "s3-path-style",
      origin: "https://s3.amazonaws.com",
      bucket: "zotero-files",
    }]);
    await assert.rejects(
      () => client.downloadAttachment({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        itemKey: "ABCD1234",
        maximumBytes: 100,
      }),
      ZoteroAdapterError,
    );
    assert.equal(calls, 1);
  }
});

test("allowlist configuration rejects shared S3 origins without a bucket constraint", () => {
  const invalidEntries: readonly (readonly ZoteroAttachmentBlobAllowlistEntry[])[] = [
    [],
    [{ kind: "exact-origin", origin: "http://files.example" }],
    [{ kind: "exact-origin", origin: "https://files.example/path" }],
    [{ kind: "exact-origin", origin: "https://files.example/." }],
    [{ kind: "exact-origin", origin: "https://s3.amazonaws.com" }],
    [{ kind: "exact-origin", origin: "https://127.0.0.1" }],
    [{ kind: "exact-origin", origin: "https://169.254.169.254" }],
    [{ kind: "exact-origin", origin: "https://[::1]" }],
    [{ kind: "exact-origin", origin: "https://[fe80::1]" }],
    [{ kind: "exact-origin", origin: "https://[::ffff:127.0.0.1]" }],
    [{ kind: "exact-origin", origin: "https://localhost" }],
    [{ kind: "exact-origin", origin: "https://files" }],
    [{ kind: "exact-origin", origin: "https://files.local" }],
    [{ kind: "exact-origin", origin: "https://metadata.google.internal" }],
    [{ kind: "exact-origin", origin: "https://host.docker.internal" }],
    [{
      kind: "s3-path-style",
      origin: "https://files.example",
      bucket: "zotero-files",
    }],
    [{
      kind: "s3-path-style",
      origin: "https://s3.amazonaws.com",
      bucket: "bad..bucket",
    }],
  ];
  for (const blobAllowlist of invalidEntries) {
    assert.throws(() => adapter(async () => blobResponse(), {}, blobAllowlist));
  }
});

test("requires one manual 302 and refuses a second redirect", async () => {
  for (const status of [200, 301, 303, 307, 308]) {
    let calls = 0;
    const client = adapter(async () => {
      calls += 1;
      return new Response(null, { status });
    });
    await assert.rejects(
      () => client.downloadAttachment({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        itemKey: "ABCD1234",
        maximumBytes: 100,
      }),
      ZoteroAdapterError,
    );
    assert.equal(calls, 1);
  }

  let calls = 0;
  const client = adapter(async () => {
    calls += 1;
    return calls === 1
      ? apiRedirect()
      : new Response(null, {
          status: 302,
          headers: { Location: "https://attacker.example/next" },
        });
  });
  await assert.rejects(
    () => client.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    ZoteroAdapterError,
  );
  assert.equal(calls, 2);
});

test("fails closed when Fetch omits or changes final response URL metadata", async () => {
  const missingUrl = new ZoteroAttachmentBinaryAdapter({
    credentialResolver: async () => ({ accessToken: "server-resolved-key" }),
    blobAllowlist: [{ kind: "exact-origin", origin: DIRECT_BLOB_ORIGIN }],
    fetchImpl: async () => apiRedirect(),
  });
  await assert.rejects(
    () => missingUrl.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
  );

  for (const responseProperties of [
    { redirected: false, url: "https://api.zotero.org/users/42/items/OTHER123/file" },
    { redirected: true, url: "https://api.zotero.org/users/42/items/ABCD1234/file" },
  ]) {
    const client = adapter(async () => {
      const response = apiRedirect();
      Object.defineProperties(response, {
        redirected: { configurable: true, value: responseProperties.redirected },
        url: { configurable: true, value: responseProperties.url },
      });
      return response;
    });
    await assert.rejects(
      () => client.downloadAttachment({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        itemKey: "ABCD1234",
        maximumBytes: 100,
      }),
      ZoteroAdapterError,
    );
  }
});

test("strictly parses required Zotero file metadata and provider throttles", async () => {
  const malformedHeaders: Array<Record<string, string | undefined>> = [
    { "Zotero-File-MD5": undefined },
    { "Zotero-File-MD5": "not-an-md5" },
    { "Zotero-File-Size": undefined },
    { "Zotero-File-Size": "04" },
    { "Zotero-File-Compressed": undefined },
    { "Zotero-File-Compressed": "false" },
    { "Zotero-File-Compressed": "Yes" },
    { "Zotero-File-Modification-Time": undefined },
    { "Zotero-File-Modification-Time": "1.5" },
    { Backoff: "-1" },
    { "Retry-After": "soon" },
  ];
  for (const overrides of malformedHeaders) {
    const client = adapter(async () => apiRedirect(SIGNED_LOCATION, overrides));
    await assert.rejects(
      () => client.downloadAttachment({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        itemKey: "ABCD1234",
        maximumBytes: 100,
      }),
      (error: unknown) =>
        error instanceof ZoteroAdapterError
        && error.code === "zotero_bad_response",
    );
  }

  const rateLimited = adapter(async () => new Response(null, {
    status: 429,
    headers: { Backoff: "9", "Retry-After": "15" },
  }), { now: () => new Date("2026-08-29T12:00:00.000Z") });
  await assert.rejects(
    () => rateLimited.downloadAttachment({
      ...CONNECTION,
      library: { kind: "group", id: "99" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_rate_limited"
      && error.backoffSeconds === 9
      && error.retryAfterSeconds === 15
      && error.retryAt === "2026-08-29T12:00:15.000Z",
  );
});

test("bounds headers, declared sizes, encodings, lengths, and strong ETags", async () => {
  let calls = 0;
  const oversizedHeaders = adapter(async () => {
    calls += 1;
    return apiRedirect(SIGNED_LOCATION, { "X-Oversized": "x".repeat(40_000) });
  });
  await assert.rejects(
    () => oversizedHeaders.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
  );
  assert.equal(calls, 1);

  const cases: Array<Record<string, string | undefined>> = [
    { "Content-Length": undefined },
    { "Content-Length": "5" },
    { "Content-Encoding": "gzip" },
    { ETag: `W/"${FILE_MD5}"` },
    { ETag: `"${"f".repeat(32)}"` },
    { "Content-Type": "invalid" },
    { "Content-Type": "text/html" },
    { "Content-Type": "application/pdf; charset=binary" },
    { "Content-Type": "application/pdf; x=\u0001" },
  ];
  for (const headers of cases) {
    let requestCount = 0;
    const client = adapter(async () => {
      requestCount += 1;
      return requestCount === 1 ? apiRedirect() : blobResponse(FILE_BYTES, headers);
    });
    await assert.rejects(
      () => client.downloadAttachment({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        itemKey: "ABCD1234",
        maximumBytes: 100,
      }),
      ZoteroAdapterError,
    );
  }

  const tooLarge = adapter(async () => apiRedirect(SIGNED_LOCATION, {
    "Zotero-File-Size": "101",
  }));
  await assert.rejects(
    () => tooLarge.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_response_too_large"
      && error.retryable === false,
  );
});

test("allows a missing final ETag only when the streamed MD5 matches 302 metadata", async () => {
  let calls = 0;
  const client = adapter(async () => {
    calls += 1;
    return calls === 1
      ? apiRedirect()
      : blobResponse(FILE_BYTES, { ETag: undefined });
  });
  const download = await client.downloadAttachment({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    itemKey: "ABCD1234",
    maximumBytes: 100,
  });
  assert.equal(download.etagMd5, undefined);
  assert.deepEqual(await readBytes(download.body), FILE_BYTES);
  assert.deepEqual(await download.integrity, {
    md5: FILE_MD5,
    sizeBytes: FILE_BYTES.byteLength,
  });

  calls = 0;
  const inconsistent = adapter(async () => {
    calls += 1;
    return calls === 1
      ? apiRedirect()
      : blobResponse(new TextEncoder().encode("%PDX"), { ETag: undefined });
  });
  const inconsistentDownload = await inconsistent.downloadAttachment({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    itemKey: "ABCD1234",
    maximumBytes: 100,
  });
  await assert.rejects(
    () => readBytes(inconsistentDownload.body),
    (error: unknown) =>
      error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
  );
  await assert.rejects(
    inconsistentDownload.integrity,
    (error: unknown) =>
      error instanceof ZoteroAdapterError && error.code === "zotero_bad_response",
  );
});

test("counts the streamed body and keeps the timeout active until consumption", async () => {
  for (const bytes of [
    new TextEncoder().encode("%PD"),
    new TextEncoder().encode("%PDF!"),
  ]) {
    let calls = 0;
    const client = adapter(async () => {
      calls += 1;
      return calls === 1 ? apiRedirect() : blobResponse(bytes);
    });
    const download = await client.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    });
    await assert.rejects(
      () => readBytes(download.body),
      (error: unknown) =>
        error instanceof ZoteroAdapterError
        && error.code === "zotero_bad_response",
    );
  }

  let calls = 0;
  let providerSignal: AbortSignal | null = null;
  const timedClient = adapter(async (_input, init) => {
    calls += 1;
    if (calls === 1) return apiRedirect();
    providerSignal = init?.signal ?? null;
    return new Response(new ReadableStream<Uint8Array>({
      start() {
        // Intentionally never produce the four declared bytes.
      },
    }), {
      status: 200,
      headers: {
        "Content-Length": "4",
        "Content-Type": "application/pdf",
        ETag: `"${FILE_MD5}"`,
      },
    });
  }, { timeoutMs: 20 });
  const timedDownload = await timedClient.downloadAttachment({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    itemKey: "ABCD1234",
    maximumBytes: 100,
  });
  await assert.rejects(
    () => timedDownload.body.getReader().read(),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_timeout",
  );
  assert.equal((providerSignal as AbortSignal | null)?.aborted, true);
});

test("does not retain a signed Location in errors when the blob request fails", async () => {
  let calls = 0;
  const client = adapter(async () => {
    calls += 1;
    if (calls === 1) return apiRedirect();
    throw new Error(`network failure for ${SIGNED_LOCATION}`);
  });
  await assert.rejects(
    () => client.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ZoteroAdapterError);
      assert.equal(error.code, "zotero_unavailable");
      assert.equal(String(error).includes(SIGNED_LOCATION), false);
      assert.equal(String(error.stack).includes(SIGNED_LOCATION), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("normalizes signed-URL-bearing source stream errors and supports consumer cleanup", async () => {
  let calls = 0;
  const sourceError = adapter(async () => {
    calls += 1;
    if (calls === 1) return apiRedirect();
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error(`source error for ${SIGNED_LOCATION}`));
      },
    }), {
      status: 200,
      headers: {
        "Content-Length": "4",
        "Content-Type": "application/pdf",
      },
    });
  });
  const failedDownload = await sourceError.downloadAttachment({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    itemKey: "ABCD1234",
    maximumBytes: 100,
  });
  await assert.rejects(
    () => failedDownload.body.getReader().read(),
    (error: unknown) => {
      assert.ok(error instanceof ZoteroAdapterError);
      assert.equal(String(error).includes(SIGNED_LOCATION), false);
      assert.equal(String(error.stack).includes(SIGNED_LOCATION), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  await assert.rejects(failedDownload.integrity);

  let upstreamCancelled = false;
  calls = 0;
  const cancellable = adapter(async () => {
    calls += 1;
    if (calls === 1) return apiRedirect();
    return new Response(new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancelled = true;
      },
    }), {
      status: 200,
      headers: {
        "Content-Length": "4",
        "Content-Type": "application/pdf",
      },
    });
  });
  const cancellableDownload = await cancellable.downloadAttachment({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    itemKey: "ABCD1234",
    maximumBytes: 100,
  });
  await cancellableDownload.body.cancel();
  assert.equal(upstreamCancelled, true);
  await assert.rejects(cancellableDownload.integrity, ZoteroAdapterError);
});

test("cancels response bodies on validation failure", async () => {
  let apiBodyCancelled = false;
  const badApi = adapter(async () => new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        apiBodyCancelled = true;
      },
    }),
    {
      status: 302,
      headers: {
        Location: SIGNED_LOCATION,
        "Zotero-File-MD5": FILE_MD5,
        "Zotero-File-Size": "4",
        "Zotero-File-Compressed": "Yes",
        "Zotero-File-Modification-Time": "1788019200123",
      },
    },
  ));
  await assert.rejects(
    () => badApi.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    ZoteroAdapterError,
  );
  assert.equal(apiBodyCancelled, true);

  let calls = 0;
  let blobBodyCancelled = false;
  const badBlob = adapter(async () => {
    calls += 1;
    if (calls === 1) return apiRedirect();
    return new Response(new ReadableStream<Uint8Array>({
      cancel() {
        blobBodyCancelled = true;
      },
    }), {
      status: 200,
      headers: {
        "Content-Length": "4",
        "Content-Type": "text/html",
      },
    });
  });
  await assert.rejects(
    () => badBlob.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    ZoteroAdapterError,
  );
  assert.equal(blobBodyCancelled, true);
});

test("external cancellation fences every hop and the returned stream", async () => {
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let fetchCalls = 0;
  const neverFetch = adapter(async () => {
    fetchCalls += 1;
    return apiRedirect();
  });
  await assert.rejects(
    () => neverFetch.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
      signal: alreadyAborted.signal,
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError && error.code === "zotero_unavailable",
  );
  assert.equal(fetchCalls, 0);

  const betweenHops = new AbortController();
  let calls = 0;
  let returnedBlobCancelled = false;
  const abortingBlob = adapter(async () => {
    calls += 1;
    if (calls === 1) return apiRedirect();
    betweenHops.abort();
    return new Response(new ReadableStream<Uint8Array>({
      cancel() {
        returnedBlobCancelled = true;
      },
    }), {
      status: 200,
      headers: {
        "Content-Length": "4",
        "Content-Type": "application/pdf",
      },
    });
  });
  await assert.rejects(
    () => abortingBlob.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
      signal: betweenHops.signal,
    }),
    ZoteroAdapterError,
  );
  assert.equal(returnedBlobCancelled, true);

  const duringStream = new AbortController();
  calls = 0;
  let streamCancelled = false;
  const streaming = adapter(async () => {
    calls += 1;
    if (calls === 1) return apiRedirect();
    return new Response(new ReadableStream<Uint8Array>({
      cancel() {
        streamCancelled = true;
      },
    }), {
      status: 200,
      headers: {
        "Content-Length": "4",
        "Content-Type": "application/pdf",
      },
    });
  });
  const streamingDownload = await streaming.downloadAttachment({
    ...CONNECTION,
    library: { kind: "user", id: "42" },
    itemKey: "ABCD1234",
    maximumBytes: 100,
    signal: duringStream.signal,
  });
  const pendingRead = streamingDownload.body.getReader().read();
  duringStream.abort();
  await assert.rejects(pendingRead, ZoteroAdapterError);
  await assert.rejects(streamingDownload.integrity, ZoteroAdapterError);
  assert.equal(streamCancelled, true);
});

test("timeouts abort either HTTP hop without retaining provider errors", async () => {
  for (const stalledHop of [1, 2]) {
    let calls = 0;
    let observedAbort = false;
    const client = adapter(async (_input, init) => {
      calls += 1;
      if (calls < stalledHop) return apiRedirect();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new Error(`timed out at ${SIGNED_LOCATION}`));
        }, { once: true });
      });
    }, { timeoutMs: 20 });
    await assert.rejects(
      () => client.downloadAttachment({
        ...CONNECTION,
        library: { kind: "user", id: "42" },
        itemKey: "ABCD1234",
        maximumBytes: 100,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ZoteroAdapterError);
        assert.equal(error.code, "zotero_timeout");
        assert.equal(String(error).includes(SIGNED_LOCATION), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.equal(observedAbort, true);
  }
});

test("strong attachment ETags are optional, quoted, non-weak MD5 validators", () => {
  assert.equal(parseStrongZoteroAttachmentEtag(null), undefined);
  assert.equal(
    parseStrongZoteroAttachmentEtag(`"${FILE_MD5.toUpperCase()}"`),
    FILE_MD5,
  );
  for (const value of [
    FILE_MD5,
    `W/"${FILE_MD5}"`,
    `"${FILE_MD5}-2"`,
    '"not-a-hash"',
    `"${FILE_MD5}", "${FILE_MD5}"`,
  ]) {
    assert.throws(
      () => parseStrongZoteroAttachmentEtag(value),
      ZoteroAdapterError,
    );
  }
});

test("invalid tenant context and unavailable credentials fail before network access", async () => {
  let resolverCalls = 0;
  let fetchCalls = 0;
  const client = adapter(async () => {
    fetchCalls += 1;
    return apiRedirect();
  }, {
    credentialResolver: async () => {
      resolverCalls += 1;
      return null;
    },
  });
  await assert.rejects(
    () => client.downloadAttachment({
      organizationId: "workspace-a\r\nforeign",
      connectionId: "connection-a",
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_invalid_request",
  );
  assert.equal(resolverCalls, 0);
  await assert.rejects(
    () => client.downloadAttachment({
      ...CONNECTION,
      library: { kind: "user", id: "42" },
      itemKey: "ABCD1234",
      maximumBytes: 100,
    }),
    (error: unknown) =>
      error instanceof ZoteroAdapterError
      && error.code === "zotero_credential_unavailable",
  );
  assert.equal(resolverCalls, 1);
  assert.equal(fetchCalls, 0);
});
