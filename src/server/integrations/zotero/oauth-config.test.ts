import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  zoteroCallbackUrlWithState,
  zoteroOAuthConfigurationFromEnvironment,
  zoteroOAuthResultRedirect,
} from "./oauth-config";

const BASE_ENVIRONMENT = {
  BETTER_AUTH_URL: "https://app.paperpilot.test",
  BETTER_AUTH_SECRET: "auth-secret-that-is-independent-and-long",
  ZOTERO_OAUTH_CONSUMER_KEY: "consumer-key-123",
  ZOTERO_OAUTH_CONSUMER_SECRET: "consumer-secret-that-is-long-enough",
  ZOTERO_OAUTH_STATE_SECRET: "state-secret-that-is-independent-and-at-least-32-bytes",
  ZOTERO_OAUTH_CALLBACK_URL:
    "https://app.paperpilot.test/api/integrations/zotero/oauth/callback",
} as const;

describe("Zotero OAuth server configuration", () => {
  it("accepts only the exact canonical HTTPS application callback", () => {
    const configuration = zoteroOAuthConfigurationFromEnvironment(BASE_ENVIRONMENT);
    assert.equal(
      configuration.callbackUrl.toString(),
      "https://app.paperpilot.test/api/integrations/zotero/oauth/callback",
    );

    for (const callbackUrl of [
      "http://app.paperpilot.test/api/integrations/zotero/oauth/callback",
      "https://other.paperpilot.test/api/integrations/zotero/oauth/callback",
      "https://app.paperpilot.test/api/integrations/zotero/oauth/callback/",
      "https://app.paperpilot.test/api/integrations/zotero/oauth/callback?state=x",
      "https://user@app.paperpilot.test/api/integrations/zotero/oauth/callback",
    ]) {
      assert.throws(() =>
        zoteroOAuthConfigurationFromEnvironment({
          ...BASE_ENVIRONMENT,
          ZOTERO_OAUTH_CALLBACK_URL: callbackUrl,
        }),
      );
    }

    assert.throws(() =>
      zoteroOAuthConfigurationFromEnvironment({
        ...BASE_ENVIRONMENT,
        BETTER_AUTH_URL: "http://app.paperpilot.test",
      }),
    );
  });

  it("rejects missing, weak, reused, placeholder, and whitespace-mutated secrets", () => {
    for (const environment of [
      { ...BASE_ENVIRONMENT, ZOTERO_OAUTH_CONSUMER_KEY: "" },
      { ...BASE_ENVIRONMENT, ZOTERO_OAUTH_CONSUMER_SECRET: "too-short" },
      { ...BASE_ENVIRONMENT, ZOTERO_OAUTH_STATE_SECRET: "replace-me-with-a-secret-that-is-long-enough" },
      {
        ...BASE_ENVIRONMENT,
        ZOTERO_OAUTH_STATE_SECRET: BASE_ENVIRONMENT.ZOTERO_OAUTH_CONSUMER_SECRET,
      },
      {
        ...BASE_ENVIRONMENT,
        ZOTERO_OAUTH_STATE_SECRET: ` ${BASE_ENVIRONMENT.ZOTERO_OAUTH_STATE_SECRET}`,
      },
    ]) {
      assert.throws(() => zoteroOAuthConfigurationFromEnvironment(environment));
    }
  });

  it("builds one exact state callback and clean credential-free result redirects", () => {
    const configuration = zoteroOAuthConfigurationFromEnvironment(BASE_ENVIRONMENT);
    const callback = zoteroCallbackUrlWithState(configuration, "signed.state_~token");
    assert.equal(
      callback.toString(),
      "https://app.paperpilot.test/api/integrations/zotero/oauth/callback?state=signed.state_%7Etoken",
    );
    assert.equal(callback.searchParams.getAll("state").length, 1);

    assert.equal(
      zoteroOAuthResultRedirect(configuration, "connected").toString(),
      "https://app.paperpilot.test/app?zotero=connected#sources",
    );
    assert.equal(
      zoteroOAuthResultRedirect(configuration, "failed").toString(),
      "https://app.paperpilot.test/app?zotero=failed#sources",
    );
  });

  it("bounds callback state and rejects controls", () => {
    const configuration = zoteroOAuthConfigurationFromEnvironment(BASE_ENVIRONMENT);
    for (const state of ["", "bad\r\nstate", "x".repeat(4 * 1024 + 1)]) {
      assert.throws(() => zoteroCallbackUrlWithState(configuration, state));
    }
  });
});
