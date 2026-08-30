import assert from "node:assert/strict";
import test from "node:test";

import {
  ZOTERO_OAUTH_ACCESS_TOKEN_URL,
  ZOTERO_OAUTH_AUTHORIZE_URL,
  ZOTERO_OAUTH_ORIGIN,
  ZOTERO_OAUTH_REQUEST_TOKEN_URL,
  ZoteroOAuthClient,
  ZoteroOAuthError,
  assertZoteroOAuthProviderUrl,
  buildOAuthAuthorizationHeader,
  buildOAuthBaseStringUri,
  buildOAuthSignatureBaseString,
  buildZoteroAuthorizationUrl,
  createOAuthHmacSha1Signature,
  normalizeOAuthParameters,
  oauthPercentEncode,
  signOAuthRequest,
  type OAuthParameter,
} from "./oauth";

const FIXED_CLOCK = () => 1_700_000_000_123;
const FIXED_NONCE = () => "fixed-nonce";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function successfulFetch(
  body: BodyInit,
  calls: FetchCall[] = [],
  responseInit: ResponseInit = { status: 200 },
): typeof fetch {
  return async (input, init) => {
    calls.push({ url: input.toString(), init });
    return new Response(body, responseInit);
  };
}

function authorizationParameters(value: string | null): Map<string, string> {
  if (value === null || !value.startsWith("OAuth ")) {
    assert.fail("Expected an OAuth Authorization header.");
  }
  const result = new Map<string, string>();
  for (const field of value.slice("OAuth ".length).split(/,\s*/)) {
    const match = field.match(/^([^=]+)="([^"]*)"$/);
    assert.ok(match, `invalid Authorization field: ${field}`);
    result.set(decodeURIComponent(match[1]), decodeURIComponent(match[2]));
  }
  return result;
}

async function captureError(operation: Promise<unknown>): Promise<ZoteroOAuthError> {
  try {
    await operation;
  } catch (error) {
    assert.ok(error instanceof ZoteroOAuthError);
    return error;
  }
  assert.fail("Expected the OAuth operation to fail.");
}

test("RFC 5849 percent encoding uses UTF-8 and only leaves unreserved bytes", () => {
  assert.equal(oauthPercentEncode("abcABC123-._~"), "abcABC123-._~");
  assert.equal(
    oauthPercentEncode("Ladies + Gentlemen"),
    "Ladies%20%2B%20Gentlemen",
  );
  assert.equal(oauthPercentEncode("An encoded string!"), "An%20encoded%20string%21");
  assert.equal(oauthPercentEncode("Dogs, Cats & Mice"), "Dogs%2C%20Cats%20%26%20Mice");
  assert.equal(oauthPercentEncode("☃/😀"), "%E2%98%83%2F%F0%9F%98%80");
  assert.throws(() => oauthPercentEncode("\uD800"), /invalid Unicode/);
});

test("RFC 5849 base string URI examples lowercase hosts and remove default ports", () => {
  assert.equal(
    buildOAuthBaseStringUri("http://EXAMPLE.COM:80/r%20v/X?id=123"),
    "http://example.com/r%20v/X",
  );
  assert.equal(
    buildOAuthBaseStringUri("https://www.example.net:8080/?q=1#ignored"),
    "https://www.example.net:8080/",
  );
  assert.equal(buildOAuthBaseStringUri("https://EXAMPLE.com:443"), "https://example.com/");
  assert.throws(
    () => buildOAuthBaseStringUri("https://user@example.com/resource"),
    /without userinfo/,
  );
});

test("RFC 5849 request parameters preserve duplicates and sort encoded names then values", () => {
  const parameters: OAuthParameter[] = [
    ["b5", "=%3D"],
    ["a3", "a"],
    ["c@", ""],
    ["a2", "r b"],
    ["oauth_consumer_key", "9djdj82h48djs9d2"],
    ["oauth_token", "kkk9d7dh3k39sjv7"],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", "137131201"],
    ["oauth_nonce", "7d8f3e4a"],
    ["c2", ""],
    ["a3", "2 q"],
    ["oauth_signature", "excluded"],
  ];

  assert.equal(
    normalizeOAuthParameters(parameters),
    "a2=r%20b&a3=2%20q&a3=a&b5=%3D%253D&c%40=&c2=&oauth_consumer_key=9djdj82h48djs9d2&oauth_nonce=7d8f3e4a&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131201&oauth_token=kkk9d7dh3k39sjv7",
  );
});

test("RFC 5849 signature base string and corrected HMAC-SHA1 errata vector match", () => {
  const url =
    "http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b";
  const parameters: OAuthParameter[] = [
    ["oauth_consumer_key", "9djdj82h48djs9d2"],
    ["oauth_token", "kkk9d7dh3k39sjv7"],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", "137131201"],
    ["oauth_nonce", "7d8f3e4a"],
    ["c2", ""],
    ["a3", "2 q"],
  ];
  const baseString = buildOAuthSignatureBaseString({
    method: "post",
    url,
    parameters,
  });

  assert.equal(
    baseString,
    "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
  );
  assert.equal(
    createOAuthHmacSha1Signature(
      baseString,
      "j49sk3j29djd",
      "dh893hdasih9",
    ),
    "r6/TJjbCOr97/+UU0NsvSne7s5g=",
  );
  assert.equal(
    signOAuthRequest({
      method: "POST",
      url,
      parameters,
      consumerSecret: "j49sk3j29djd",
      tokenSecret: "dh893hdasih9",
    }),
    "r6/TJjbCOr97/+UU0NsvSne7s5g=",
  );
});

test("signature construction rejects malformed form encoding and invalid methods", () => {
  assert.throws(
    () =>
      buildOAuthSignatureBaseString({
        method: "POST",
        url: "https://example.com/?bad=%ZZ",
      }),
    /percent-encoded UTF-8/,
  );
  assert.throws(
    () =>
      buildOAuthSignatureBaseString({
        method: "POST\r\nInjected: true",
        url: "https://example.com/",
      }),
    /valid HTTP method/,
  );
});

test("Authorization headers are deterministic, RFC-encoded, and header-injection safe", () => {
  assert.equal(
    buildOAuthAuthorizationHeader(
      [
        ["oauth_signature", "r6/TJjbCOr97/+UU0NsvSne7s5g="],
        ["oauth_consumer_key", "key"],
        ["oauth_nonce", "line\r\nbreak"],
      ],
      "Example realm",
    ),
    'OAuth realm="Example%20realm", oauth_consumer_key="key", oauth_nonce="line%0D%0Abreak", oauth_signature="r6%2FTJjbCOr97%2F%2BUU0NsvSne7s5g%3D"',
  );
  assert.throws(
    () => buildOAuthAuthorizationHeader([["library_access", "1"]]),
    /Only OAuth protocol parameters/,
  );
  assert.throws(
    () =>
      buildOAuthAuthorizationHeader([
        ["oauth_nonce", "one"],
        ["oauth_nonce", "two"],
      ]),
    /duplicate/,
  );
});

test("Zotero provider URLs are pinned to its exact HTTPS web origin", () => {
  assert.equal(
    assertZoteroOAuthProviderUrl(ZOTERO_OAUTH_REQUEST_TOKEN_URL).origin,
    ZOTERO_OAUTH_ORIGIN,
  );
  for (const value of [
    "http://www.zotero.org/oauth/request",
    "https://www.zotero.org.evil.example/oauth/request",
    "https://zotero.org/oauth/request",
    "https://token@www.zotero.org/oauth/request",
    "https://www.zotero.org.:443/oauth/request",
  ]) {
    assert.throws(
      () => assertZoteroOAuthProviderUrl(value),
      /outside the trusted Zotero origin/,
    );
  }
});

test("Zotero authorization URL maps documented permission fields without signing secrets", () => {
  const url = buildZoteroAuthorizationUrl("request-token", {
    name: "PaperPilot inbound metadata",
    libraryAccess: true,
    notesAccess: false,
    writeAccess: false,
    allGroups: "read",
  });

  assert.equal(`${url.origin}${url.pathname}`, ZOTERO_OAUTH_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("oauth_token"), "request-token");
  assert.equal(url.searchParams.get("name"), "PaperPilot inbound metadata");
  assert.equal(url.searchParams.get("library_access"), "1");
  assert.equal(url.searchParams.get("notes_access"), "0");
  assert.equal(url.searchParams.get("write_access"), "0");
  assert.equal(url.searchParams.get("all_groups"), "read");
  assert.equal(url.searchParams.has("oauth_signature"), false);

  const identityUrl = buildZoteroAuthorizationUrl("identity-token", {
    identityOnly: true,
  });
  assert.equal(identityUrl.searchParams.get("identity"), "1");
  assert.throws(
    () =>
      buildZoteroAuthorizationUrl("identity-token", {
        identityOnly: true,
        libraryAccess: true,
      }),
    /cannot request API key permissions/,
  );
});

test("request-token exchange is deterministic, signed, and sends no secret in URL or body", async () => {
  const calls: FetchCall[] = [];
  const client = new ZoteroOAuthClient({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    fetchImpl: successfulFetch(
      "oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true",
      calls,
    ),
  });

  const credentials = await client.requestTemporaryCredentials(
    "https://PAPERPILOT.EXAMPLE:443/api/integrations/zotero/oauth/callback?state=signed-state",
  );
  assert.deepEqual(credentials, {
    requestToken: "request-token",
    requestTokenSecret: "request-secret",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ZOTERO_OAUTH_REQUEST_TOKEN_URL);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, null);
  assert.equal(calls[0].init?.redirect, "manual");
  assert.equal(calls[0].init?.credentials, "omit");
  assert.equal(calls[0].init?.cache, "no-store");

  const headers = new Headers(calls[0].init?.headers);
  const parameters = authorizationParameters(headers.get("authorization"));
  assert.equal(parameters.get("oauth_consumer_key"), "consumer-key");
  assert.equal(parameters.get("oauth_nonce"), "fixed-nonce");
  assert.equal(parameters.get("oauth_signature_method"), "HMAC-SHA1");
  assert.equal(parameters.get("oauth_timestamp"), "1700000000");
  assert.equal(parameters.get("oauth_version"), "1.0");
  assert.equal(
    parameters.get("oauth_callback"),
    "https://paperpilot.example/api/integrations/zotero/oauth/callback?state=signed-state",
  );
  assert.equal(
    parameters.get("oauth_signature"),
    "m7dw3AB+GHpOM+HgbiXjmZsvcto=",
  );
  assert.equal(headers.get("authorization")?.includes("consumer-secret"), false);
  assert.equal(calls[0].url.includes("consumer-secret"), false);
  assert.equal(calls[0].url.includes("signed-state"), false);
  assert.equal((calls[0].init?.signal as AbortSignal).aborted, false);
});

test("access-token exchange signs the temporary secret and returns only Zotero's API key identity", async () => {
  const calls: FetchCall[] = [];
  const client = new ZoteroOAuthClient({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    fetchImpl: successfulFetch(
      "oauth_token=long-lived-key&oauth_token_secret=long-lived-key&userID=123456&username=ignored",
      calls,
    ),
  });

  const credentials = await client.exchangeAccessToken({
    requestToken: "request-token",
    requestTokenSecret: "temporary-secret-never-send",
    verifier: "verifier-value",
  });
  assert.deepEqual(credentials, {
    accessToken: "long-lived-key",
    userId: "123456",
  });
  assert.equal(calls[0].url, ZOTERO_OAUTH_ACCESS_TOKEN_URL);
  const authorization = new Headers(calls[0].init?.headers).get("authorization");
  const parameters = authorizationParameters(authorization);
  assert.equal(parameters.get("oauth_token"), "request-token");
  assert.equal(parameters.get("oauth_verifier"), "verifier-value");
  assert.ok(parameters.get("oauth_signature"));
  assert.equal(authorization?.includes("temporary-secret-never-send"), false);
  assert.equal(authorization?.includes("consumer-secret"), false);
});

test("the client rejects insecure callbacks before nonce generation or fetch", async () => {
  let nonceCalls = 0;
  let fetchCalls = 0;
  const client = new ZoteroOAuthClient({
    consumerKey: "consumer-key",
    consumerSecret: "consumer-secret",
    nonce: () => {
      nonceCalls += 1;
      return "nonce";
    },
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response();
    },
  });

  await assert.rejects(
    client.requestTemporaryCredentials("http://paperpilot.example/callback"),
    (error: unknown) =>
      error instanceof ZoteroOAuthError &&
      error.code === "zotero_oauth_invalid_request",
  );
  await assert.rejects(
    client.requestTemporaryCredentials("https://user@paperpilot.example/callback"),
    /without userinfo or a fragment/,
  );
  await assert.rejects(
    client.requestTemporaryCredentials("https://paperpilot.example/callback#state"),
    /without userinfo or a fragment/,
  );
  assert.equal(nonceCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("request-token responses require callback confirmation and unique complete fields", async () => {
  for (const body of [
    "oauth_token=t&oauth_token_secret=s",
    "oauth_token=t&oauth_token_secret=s&oauth_callback_confirmed=false",
    "oauth_token=&oauth_token_secret=s&oauth_callback_confirmed=true",
    "oauth_token=t&oauth_token=t2&oauth_token_secret=s&oauth_callback_confirmed=true",
    "oauth_token=%ZZ&oauth_token_secret=s&oauth_callback_confirmed=true",
  ]) {
    const client = new ZoteroOAuthClient({
      consumerKey: "key",
      consumerSecret: "secret",
      clock: FIXED_CLOCK,
      nonce: FIXED_NONCE,
      fetchImpl: successfulFetch(body),
    });
    const error = await captureError(
      client.requestTemporaryCredentials("https://paperpilot.example/callback"),
    );
    assert.equal(error.code, "zotero_oauth_bad_response");
    assert.equal(error.providerStatus, 200);
  }
});

test("access-token responses enforce Zotero's key invariant and a positive decimal user ID", async () => {
  for (const body of [
    "oauth_token=one&oauth_token_secret=two&userID=12",
    "oauth_token=key&oauth_token_secret=key",
    "oauth_token=key&oauth_token_secret=key&userID=0",
    "oauth_token=key&oauth_token_secret=key&userID=12.5",
  ]) {
    const client = new ZoteroOAuthClient({
      consumerKey: "key",
      consumerSecret: "secret",
      clock: FIXED_CLOCK,
      nonce: FIXED_NONCE,
      fetchImpl: successfulFetch(body),
    });
    const error = await captureError(
      client.exchangeAccessToken({
        requestToken: "request-token",
        requestTokenSecret: "request-secret",
        verifier: "verifier",
      }),
    );
    assert.equal(error.code, "zotero_oauth_bad_response");
    assert.equal(error.providerStatus, 200);
  }
});

test("OAuth response bodies are bounded by declared and streamed byte counts", async () => {
  const declaredClient = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    maxResponseBytes: 8,
    fetchImpl: successfulFetch("too large", [], {
      status: 200,
      headers: { "Content-Length": "9" },
    }),
  });
  const declaredError = await captureError(
    declaredClient.requestTemporaryCredentials("https://paperpilot.example/callback"),
  );
  assert.equal(declaredError.code, "zotero_oauth_bad_response");
  assert.match(declaredError.message, /oversized/);

  const streamedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("12345"));
      controller.enqueue(new TextEncoder().encode("6789"));
      controller.close();
    },
  });
  const streamedClient = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    maxResponseBytes: 8,
    fetchImpl: successfulFetch(streamedBody),
  });
  const streamedError = await captureError(
    streamedClient.requestTemporaryCredentials("https://paperpilot.example/callback"),
  );
  assert.equal(streamedError.code, "zotero_oauth_bad_response");
  assert.match(streamedError.message, /oversized/);
});

test("invalid response lengths and UTF-8 fail closed", async () => {
  const invalidLengthClient = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    fetchImpl: successfulFetch("body", [], {
      status: 200,
      headers: { "Content-Length": "NaN" },
    }),
  });
  assert.equal(
    (
      await captureError(
        invalidLengthClient.requestTemporaryCredentials(
          "https://paperpilot.example/callback",
        ),
      )
    ).code,
    "zotero_oauth_bad_response",
  );

  const invalidUtf8Client = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    fetchImpl: successfulFetch(new Uint8Array([0xff, 0xfe])),
  });
  const utf8Error = await captureError(
    invalidUtf8Client.requestTemporaryCredentials(
      "https://paperpilot.example/callback",
    ),
  );
  assert.equal(utf8Error.code, "zotero_oauth_bad_response");
  assert.match(utf8Error.message, /UTF-8/);
});

test("provider, redirect, network, and timeout failures have stable sanitized errors", async () => {
  const leakedValues = [
    "consumer-secret",
    "request-secret",
    "provider-echoed-secret",
  ];

  for (const [status, code, retryable] of [
    [401, "zotero_oauth_provider_rejected", false],
    [429, "zotero_oauth_unavailable", true],
    [503, "zotero_oauth_unavailable", true],
    [302, "zotero_oauth_bad_response", false],
  ] as const) {
    const client = new ZoteroOAuthClient({
      consumerKey: "key",
      consumerSecret: leakedValues[0],
      clock: FIXED_CLOCK,
      nonce: FIXED_NONCE,
      fetchImpl: successfulFetch(leakedValues[2], [], { status }),
    });
    const error = await captureError(
      client.exchangeAccessToken({
        requestToken: "request-token",
        requestTokenSecret: leakedValues[1],
        verifier: "verifier",
      }),
    );
    assert.equal(error.code, code);
    assert.equal(error.providerStatus, status);
    assert.equal(error.retryable, retryable);
    assert.equal(Object.hasOwn(error, "cause"), false);
    for (const leakedValue of leakedValues) {
      assert.equal(String(error).includes(leakedValue), false);
      assert.equal(JSON.stringify(error).includes(leakedValue), false);
    }
  }

  const networkClient = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "consumer-secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    fetchImpl: async () => {
      throw new Error("network failed with consumer-secret");
    },
  });
  const networkError = await captureError(
    networkClient.requestTemporaryCredentials(
      "https://paperpilot.example/callback",
    ),
  );
  assert.equal(networkError.code, "zotero_oauth_unavailable");
  assert.equal(String(networkError).includes("consumer-secret"), false);
  assert.equal(Object.hasOwn(networkError, "cause"), false);

  let signal: AbortSignal | undefined;
  const timeoutClient = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    timeoutMs: 5,
    fetchImpl: (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    },
  });
  const timeoutError = await captureError(
    timeoutClient.requestTemporaryCredentials(
      "https://paperpilot.example/callback",
    ),
  );
  assert.equal(timeoutError.code, "zotero_oauth_timeout");
  assert.equal(timeoutError.status, 504);
  assert.equal(signal?.aborted, true);
});

test("the timeout covers response-body streaming and wins an abort rejection race", async () => {
  let bodySignal: AbortSignal | undefined;
  const stalledBody = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
  });
  const bodyClient = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    timeoutMs: 5,
    fetchImpl: async (_input, init) => {
      bodySignal = init?.signal ?? undefined;
      return new Response(stalledBody, { status: 200 });
    },
  });
  const bodyError = await captureError(
    bodyClient.requestTemporaryCredentials("https://paperpilot.example/callback"),
  );
  assert.equal(bodyError.code, "zotero_oauth_timeout");
  assert.equal(bodySignal?.aborted, true);

  const abortingClient = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    timeoutMs: 5,
    fetchImpl: (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }),
  });
  const abortError = await captureError(
    abortingClient.requestTemporaryCredentials(
      "https://paperpilot.example/callback",
    ),
  );
  assert.equal(abortError.code, "zotero_oauth_timeout");
});

test("responses claiming a redirect or different final URL are rejected", async () => {
  const redirectedResponse = new Response(
    "oauth_token=t&oauth_token_secret=s&oauth_callback_confirmed=true",
  );
  Object.defineProperty(redirectedResponse, "redirected", { value: true });
  Object.defineProperty(redirectedResponse, "url", {
    value: "https://evil.example/oauth/request",
  });
  const client = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: FIXED_CLOCK,
    nonce: FIXED_NONCE,
    fetchImpl: async () => redirectedResponse,
  });
  const error = await captureError(
    client.requestTemporaryCredentials("https://paperpilot.example/callback"),
  );
  assert.equal(error.code, "zotero_oauth_bad_response");
  assert.match(error.message, /unexpected URL/);
});

test("constructor and injected clock/nonce values are validated before fetch", async () => {
  assert.throws(
    () => new ZoteroOAuthClient({ consumerKey: "", consumerSecret: "secret" }),
    (error: unknown) =>
      error instanceof ZoteroOAuthError &&
      error.code === "zotero_oauth_invalid_configuration",
  );
  assert.throws(
    () =>
      new ZoteroOAuthClient({
        consumerKey: "key",
        consumerSecret: "secret",
        timeoutMs: 0,
      }),
    /between 1 and 120000/,
  );

  let fetchCalls = 0;
  const client = new ZoteroOAuthClient({
    consumerKey: "key",
    consumerSecret: "secret",
    clock: () => Number.NaN,
    nonce: () => "unsafe\r\nnonce",
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response();
    },
  });
  const error = await captureError(
    client.requestTemporaryCredentials("https://paperpilot.example/callback"),
  );
  assert.equal(error.code, "zotero_oauth_invalid_configuration");
  assert.equal(fetchCalls, 0);
});
