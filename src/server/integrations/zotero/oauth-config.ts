import "server-only";

const CALLBACK_PATH = "/api/integrations/zotero/oauth/callback";
const MAX_CREDENTIAL_BYTES = 4 * 1024;
const MAX_STATE_BYTES = 4 * 1024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const PLACEHOLDER_PATTERN = /(replace|placeholder|example|change[-_ ]?me)/i;

export interface ZoteroOAuthServerConfiguration {
  consumerKey: string;
  consumerSecret: string;
  stateSecret: string;
  callbackUrl: URL;
}

function requiredValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  minimumBytes: number,
): string {
  const rawValue = environment[name];
  const value = rawValue?.trim();
  if (
    !value ||
    rawValue !== value ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") < minimumBytes ||
    Buffer.byteLength(value, "utf8") > MAX_CREDENTIAL_BYTES ||
    PLACEHOLDER_PATTERN.test(value)
  ) {
    throw new Error(`${name} must contain a non-placeholder server secret between ${minimumBytes} and ${MAX_CREDENTIAL_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function canonicalCallbackUrl(
  value: string | undefined,
  applicationUrl: string | undefined,
): URL {
  let callback: URL;
  let application: URL;
  try {
    if (value !== value?.trim() || applicationUrl !== applicationUrl?.trim()) {
      throw new Error();
    }
    callback = new URL(value ?? "");
    application = new URL(applicationUrl ?? "");
  } catch {
    throw new Error(
      "ZOTERO_OAUTH_CALLBACK_URL and BETTER_AUTH_URL must be absolute URLs.",
    );
  }

  if (
    callback.protocol !== "https:" ||
    application.protocol !== "https:" ||
    callback.origin !== application.origin ||
    callback.pathname !== CALLBACK_PATH ||
    callback.search !== "" ||
    callback.hash !== "" ||
    callback.username !== "" ||
    callback.password !== "" ||
    application.username !== "" ||
    application.password !== ""
  ) {
    throw new Error(
      `ZOTERO_OAUTH_CALLBACK_URL must be the exact HTTPS application URL ${CALLBACK_PATH} without query, fragment, or userinfo.`,
    );
  }
  return callback;
}

export function zoteroOAuthConfigurationFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ZoteroOAuthServerConfiguration {
  const consumerKey = requiredValue(environment, "ZOTERO_OAUTH_CONSUMER_KEY", 8);
  const consumerSecret = requiredValue(
    environment,
    "ZOTERO_OAUTH_CONSUMER_SECRET",
    16,
  );
  const stateSecret = requiredValue(environment, "ZOTERO_OAUTH_STATE_SECRET", 32);
  if (
    stateSecret === consumerKey ||
    stateSecret === consumerSecret ||
    stateSecret === environment.BETTER_AUTH_SECRET?.trim()
  ) {
    throw new Error(
      "ZOTERO_OAUTH_STATE_SECRET must be independent from OAuth and authentication secrets.",
    );
  }

  return {
    consumerKey,
    consumerSecret,
    stateSecret,
    callbackUrl: canonicalCallbackUrl(
      environment.ZOTERO_OAUTH_CALLBACK_URL,
      environment.BETTER_AUTH_URL,
    ),
  };
}

/** The exact callback serialized into and signed with the request-token call. */
export function zoteroCallbackUrlWithState(
  configuration: Pick<ZoteroOAuthServerConfiguration, "callbackUrl">,
  state: string,
): URL {
  if (
    typeof state !== "string" ||
    state.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(state) ||
    Buffer.byteLength(state, "utf8") > MAX_STATE_BYTES
  ) {
    throw new Error("A bounded Zotero OAuth state token is required.");
  }
  const callback = new URL(configuration.callbackUrl.toString());
  callback.searchParams.set("state", state);
  return callback;
}

export function zoteroOAuthResultRedirect(
  configuration: Pick<ZoteroOAuthServerConfiguration, "callbackUrl">,
  outcome: "connected" | "failed",
): URL {
  const redirect = new URL("/app", configuration.callbackUrl.origin);
  redirect.searchParams.set("zotero", outcome);
  redirect.hash = "sources";
  return redirect;
}
