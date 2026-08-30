import assert from "node:assert/strict";
import { test } from "node:test";

import { HttpProblem } from "@/server/http/problem";
import {
  parseZoteroOAuthCallbackRequest,
  zoteroOAuthCallbackRedirect,
  zoteroOAuthUnavailableCallbackRedirect,
} from "./oauth-callback-request";
import { requireEmptyZoteroMutationBody } from "./oauth-http-request";

function callbackRequest(query: string): Request {
  return new Request(
    `https://paperpilot.test/api/integrations/zotero/oauth/callback?${query}`,
  );
}

test("callback query parsing accepts exactly three bounded single values", () => {
  assert.deepEqual(
    parseZoteroOAuthCallbackRequest(
      callbackRequest("oauth_verifier=verify_1&state=v1.payload.signature&oauth_token=token-1"),
    ),
    {
      state: "v1.payload.signature",
      requestToken: "token-1",
      verifier: "verify_1",
    },
  );
});

test("callback query parsing rejects duplicates, unknowns, missing values, and malformed encoding", () => {
  for (const query of [
    "state=s&state=again&oauth_token=t&oauth_verifier=v",
    "state=s&oauth_token=t&oauth_verifier=v&extra=x",
    "state=s&oauth_token=t",
    "state=&oauth_token=t&oauth_verifier=v",
    "state=s&oauth_token=t&oauth_verifier=%",
    "state=s&oauth_token=t&oauth_verifier=%FF",
    "state=s&&oauth_token=t&oauth_verifier=v",
    "state=s&oauth_token=t&oauth_verifier=with+space",
    `state=${"s".repeat(4 * 1024 + 1)}&oauth_token=t&oauth_verifier=v`,
  ]) {
    assert.throws(
      () => parseZoteroOAuthCallbackRequest(callbackRequest(query)),
      (error: unknown) =>
        error instanceof HttpProblem
        && error.status === 400
        && error.code === "validation",
    );
  }
  assert.throws(
    () => parseZoteroOAuthCallbackRequest(new Request(
      "https://paperpilot.test/api/integrations/zotero/oauth/callback?state=s&oauth_token=t&oauth_verifier=v",
      { method: "POST" },
    )),
    (error: unknown) => error instanceof HttpProblem && error.status === 400,
  );
});

test("callback redirects are clean 303 responses with anti-leakage headers", () => {
  const response = zoteroOAuthCallbackRedirect(
    new URL("https://paperpilot.test/app?zotero=failed#sources"),
    "callback-request-id",
  );
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://paperpilot.test/app?zotero=failed#sources",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-request-id"), "callback-request-id");
  assert.throws(() =>
    zoteroOAuthCallbackRedirect(
      new URL("http://paperpilot.test/app?zotero=failed"),
      "callback-request-id",
    ),
  );

  const unavailable = zoteroOAuthUnavailableCallbackRedirect(
    "unavailable-request-id",
  );
  assert.equal(unavailable.status, 303);
  assert.equal(unavailable.headers.get("location"), "/app?zotero=failed#sources");
  assert.equal(unavailable.headers.get("cache-control"), "no-store");
  assert.equal(unavailable.headers.get("referrer-policy"), "no-referrer");
});

test("disconnect request parsing accepts no body and rejects declared or streamed data", () => {
  assert.doesNotThrow(() =>
    requireEmptyZoteroMutationBody(new Request("https://paperpilot.test/disconnect", {
      method: "DELETE",
    })),
  );
  for (const request of [
    new Request("https://paperpilot.test/disconnect", {
      method: "DELETE",
      headers: { "Content-Length": "1" },
    }),
    new Request("https://paperpilot.test/disconnect", {
      method: "DELETE",
      body: "x",
    }),
  ]) {
    assert.throws(
      () => requireEmptyZoteroMutationBody(request),
      (error: unknown) => error instanceof HttpProblem && error.status === 400,
    );
  }
});
