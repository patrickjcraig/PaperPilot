import "server-only";

import { createHmac, randomBytes } from "node:crypto";

export const ZOTERO_OAUTH_ORIGIN = "https://www.zotero.org" as const;
export const ZOTERO_OAUTH_REQUEST_TOKEN_URL =
  "https://www.zotero.org/oauth/request" as const;
export const ZOTERO_OAUTH_ACCESS_TOKEN_URL =
  "https://www.zotero.org/oauth/access" as const;
export const ZOTERO_OAUTH_AUTHORIZE_URL =
  "https://www.zotero.org/oauth/authorize" as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 4 * 1024;
const MAX_CALLBACK_BYTES = 4 * 1024;
const MAX_AUTHORIZATION_NAME_BYTES = 512;
const MAX_FORM_PARAMETERS = 32;
const MAX_FORM_PARAMETER_BYTES = 8 * 1024;

const HTTP_METHOD_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const DECIMAL_INTEGER_PATTERN = /^(0|[1-9][0-9]*)$/;

export type OAuthParameter = readonly [name: string, value: string];

export type ZoteroOAuthErrorCode =
  | "zotero_oauth_invalid_configuration"
  | "zotero_oauth_invalid_request"
  | "zotero_oauth_invalid_state"
  | "zotero_oauth_provider_rejected"
  | "zotero_oauth_timeout"
  | "zotero_oauth_unavailable"
  | "zotero_oauth_bad_response";

export interface ZoteroOAuthErrorOptions {
  code: ZoteroOAuthErrorCode;
  status: number;
  retryable: boolean;
  providerStatus?: number;
}

/**
 * A deliberately small, serializable error surface for OAuth routes. It never
 * retains request headers, response bodies, consumer secrets, or token secrets.
 */
export class ZoteroOAuthError extends Error {
  readonly code: ZoteroOAuthErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly providerStatus?: number;

  constructor(message: string, options: ZoteroOAuthErrorOptions) {
    super(message);
    this.name = "ZoteroOAuthError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.providerStatus = options.providerStatus;
  }
}

function invalidConfiguration(message: string): ZoteroOAuthError {
  return new ZoteroOAuthError(message, {
    code: "zotero_oauth_invalid_configuration",
    status: 500,
    retryable: false,
  });
}

function invalidRequest(message: string): ZoteroOAuthError {
  return new ZoteroOAuthError(message, {
    code: "zotero_oauth_invalid_request",
    status: 400,
    retryable: false,
  });
}

function badResponse(message: string, providerStatus?: number): ZoteroOAuthError {
  return new ZoteroOAuthError(message, {
    code: "zotero_oauth_bad_response",
    status: 502,
    retryable: false,
    providerStatus,
  });
}

function utf8Length(value: string, errorFactory: (message: string) => Error): number {
  try {
    // encodeURIComponent rejects lone UTF-16 surrogates instead of silently
    // signing a replacement character that the provider did not receive.
    encodeURIComponent(value);
  } catch {
    throw errorFactory("An OAuth value contains invalid Unicode.");
  }
  return Buffer.byteLength(value, "utf8");
}

function assertString(
  value: unknown,
  label: string,
  maximumBytes: number,
  errorFactory: (message: string) => Error = invalidRequest,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw errorFactory(`${label} is required.`);
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw errorFactory(`${label} contains unsupported control characters.`);
  }
  if (utf8Length(value, errorFactory) > maximumBytes) {
    throw errorFactory(`${label} is too long.`);
  }
}

/** RFC 5849 section 3.6 encoding (UTF-8 and RFC 3986 unreserved bytes). */
export function oauthPercentEncode(value: string): string {
  if (typeof value !== "string") {
    throw invalidRequest("OAuth percent encoding requires a string value.");
  }

  try {
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    throw invalidRequest("An OAuth value contains invalid Unicode.");
  }
}

function compareEncodedValues(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Encodes, sorts, and joins request parameters per RFC 5849 section 3.4.1.3.2.
 * Duplicate names are preserved and sorted by their encoded values.
 */
export function normalizeOAuthParameters(
  parameters: Iterable<OAuthParameter>,
): string {
  const encoded: Array<readonly [string, string]> = [];

  for (const parameter of parameters) {
    if (
      !Array.isArray(parameter) ||
      parameter.length !== 2 ||
      typeof parameter[0] !== "string" ||
      typeof parameter[1] !== "string"
    ) {
      throw invalidRequest("OAuth parameters must be string name/value pairs.");
    }

    // oauth_signature is never part of the signature base string.
    if (parameter[0] === "oauth_signature") continue;
    encoded.push([
      oauthPercentEncode(parameter[0]),
      oauthPercentEncode(parameter[1]),
    ]);
  }

  encoded.sort(
    (left, right) =>
      compareEncodedValues(left[0], right[0]) ||
      compareEncodedValues(left[1], right[1]),
  );

  return encoded.map(([name, value]) => `${name}=${value}`).join("&");
}

function parseAbsoluteUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw invalidRequest("OAuth signing requires a valid absolute URL.");
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw invalidRequest("OAuth signing requires an HTTP(S) URL without userinfo.");
  }
  return url;
}

/** RFC 5849 section 3.4.1.2 base string URI. */
export function buildOAuthBaseStringUri(value: string | URL): string {
  const url = parseAbsoluteUrl(value);
  const path = url.pathname || "/";
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}

function decodeFormComponent(
  value: string,
  errorFactory: (message: string) => Error = invalidRequest,
): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    throw errorFactory(
      "An OAuth form parameter is not valid percent-encoded UTF-8.",
    );
  }
}

function parseFormPairs(
  value: string,
  errorFactory: (message: string) => Error = invalidRequest,
): OAuthParameter[] {
  if (value === "") return [];
  return value.split("&").map((part) => {
    const separator = part.indexOf("=");
    const rawName = separator === -1 ? part : part.slice(0, separator);
    const rawValue = separator === -1 ? "" : part.slice(separator + 1);
    return [
      decodeFormComponent(rawName, errorFactory),
      decodeFormComponent(rawValue, errorFactory),
    ] as const;
  });
}

function collectQueryParameters(url: URL): OAuthParameter[] {
  return parseFormPairs(url.search.length > 0 ? url.search.slice(1) : "");
}

export interface OAuthSignatureBaseStringInput {
  method: string;
  url: string | URL;
  /** OAuth header and eligible form-body parameters, excluding `realm`. */
  parameters?: Iterable<OAuthParameter>;
}

/** Builds the exact three-part signature base string from RFC 5849. */
export function buildOAuthSignatureBaseString(
  input: OAuthSignatureBaseStringInput,
): string {
  if (
    typeof input.method !== "string" ||
    !HTTP_METHOD_PATTERN.test(input.method)
  ) {
    throw invalidRequest("OAuth signing requires a valid HTTP method.");
  }

  const url = parseAbsoluteUrl(input.url);
  const parameters: OAuthParameter[] = collectQueryParameters(url);
  if (input.parameters) parameters.push(...input.parameters);

  const method = input.method.toUpperCase();
  const baseStringUri = buildOAuthBaseStringUri(url);
  const normalizedParameters = normalizeOAuthParameters(parameters);
  return [method, baseStringUri, normalizedParameters]
    .map(oauthPercentEncode)
    .join("&");
}

/** HMAC-SHA1 is required by Zotero's OAuth 1.0a handshake. */
export function createOAuthHmacSha1Signature(
  signatureBaseString: string,
  consumerSecret: string,
  tokenSecret = "",
): string {
  if (typeof signatureBaseString !== "string") {
    throw invalidRequest("An OAuth signature base string is required.");
  }
  if (typeof consumerSecret !== "string" || typeof tokenSecret !== "string") {
    throw invalidRequest("OAuth signing secrets must be strings.");
  }

  const signingKey = `${oauthPercentEncode(consumerSecret)}&${oauthPercentEncode(
    tokenSecret,
  )}`;
  return createHmac("sha1", signingKey)
    .update(signatureBaseString, "utf8")
    .digest("base64");
}

export interface SignOAuthRequestInput extends OAuthSignatureBaseStringInput {
  consumerSecret: string;
  tokenSecret?: string;
}

export function signOAuthRequest(input: SignOAuthRequestInput): string {
  return createOAuthHmacSha1Signature(
    buildOAuthSignatureBaseString(input),
    input.consumerSecret,
    input.tokenSecret,
  );
}

/**
 * Serializes OAuth protocol parameters into an injection-safe Authorization
 * header. Non-OAuth request parameters belong in the URL or form body.
 */
export function buildOAuthAuthorizationHeader(
  parameters: Iterable<OAuthParameter>,
  realm?: string,
): string {
  const fields: Array<readonly [string, string]> = [];
  const seenNames = new Set<string>();

  if (realm !== undefined) {
    if (typeof realm !== "string") {
      throw invalidRequest("An OAuth realm must be a string.");
    }
    fields.push(["realm", realm]);
  }

  for (const parameter of parameters) {
    if (
      !Array.isArray(parameter) ||
      parameter.length !== 2 ||
      typeof parameter[0] !== "string" ||
      typeof parameter[1] !== "string"
    ) {
      throw invalidRequest("OAuth parameters must be string name/value pairs.");
    }
    const [name, value] = parameter;
    if (!name.startsWith("oauth_")) {
      throw invalidRequest("Only OAuth protocol parameters may enter the header.");
    }
    if (seenNames.has(name)) {
      throw invalidRequest("An OAuth header must not contain duplicate parameters.");
    }
    seenNames.add(name);
    fields.push([name, value]);
  }

  const realmField = fields[0]?.[0] === "realm" ? fields.shift() : undefined;
  fields.sort((left, right) =>
    compareEncodedValues(oauthPercentEncode(left[0]), oauthPercentEncode(right[0])),
  );
  if (realmField) fields.unshift(realmField);

  return `OAuth ${fields
    .map(
      ([name, value]) =>
        `${oauthPercentEncode(name)}="${oauthPercentEncode(value)}"`,
    )
    .join(", ")}`;
}

/** Allows only Zotero's exact HTTPS web origin; no lookalikes or userinfo. */
export function assertZoteroOAuthProviderUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw invalidRequest("A valid Zotero OAuth provider URL is required.");
  }

  if (
    url.protocol !== "https:" ||
    url.origin !== ZOTERO_OAUTH_ORIGIN ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw invalidRequest("The OAuth URL is outside the trusted Zotero origin.");
  }
  return url;
}

function assertCallbackUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.toString()) : new URL(value);
  } catch {
    throw invalidRequest("A valid absolute OAuth callback URL is required.");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    utf8Length(url.toString(), invalidRequest) > MAX_CALLBACK_BYTES
  ) {
    throw invalidRequest(
      "The OAuth callback URL must be an HTTPS URL without userinfo or a fragment.",
    );
  }
  return url;
}

export type ZoteroAllGroupsAccess = "none" | "read" | "write";

export interface ZoteroAuthorizationOptions {
  /** Description shown on the Zotero API key authorization form. */
  name?: string;
  libraryAccess?: boolean;
  notesAccess?: boolean;
  writeAccess?: boolean;
  allGroups?: ZoteroAllGroupsAccess;
  /** Identity-only exchanges do not create an API key. */
  identityOnly?: boolean;
}

function addBooleanOption(
  searchParams: URLSearchParams,
  name: string,
  value: boolean | undefined,
): void {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw invalidRequest("A Zotero authorization permission must be boolean.");
  }
  searchParams.set(name, value ? "1" : "0");
}

/** Builds Zotero's user-facing authorization URL and permission preselection. */
export function buildZoteroAuthorizationUrl(
  requestToken: string,
  options: ZoteroAuthorizationOptions = {},
): URL {
  assertString(requestToken, "A Zotero OAuth request token", MAX_CREDENTIAL_BYTES);
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw invalidRequest("Zotero authorization options must be an object.");
  }
  if (
    options.identityOnly !== undefined &&
    typeof options.identityOnly !== "boolean"
  ) {
    throw invalidRequest("The Zotero identity-only option must be boolean.");
  }

  if (options.identityOnly) {
    if (
      options.libraryAccess !== undefined ||
      options.notesAccess !== undefined ||
      options.writeAccess !== undefined ||
      options.allGroups !== undefined ||
      options.name !== undefined
    ) {
      throw invalidRequest(
        "Identity-only Zotero authorization cannot request API key permissions.",
      );
    }
  }

  const url = new URL(ZOTERO_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("oauth_token", requestToken);

  if (options.identityOnly) {
    url.searchParams.set("identity", "1");
  } else {
    if (options.name !== undefined) {
      assertString(
        options.name,
        "A Zotero OAuth key name",
        MAX_AUTHORIZATION_NAME_BYTES,
      );
      url.searchParams.set("name", options.name);
    }
    addBooleanOption(url.searchParams, "library_access", options.libraryAccess);
    addBooleanOption(url.searchParams, "notes_access", options.notesAccess);
    addBooleanOption(url.searchParams, "write_access", options.writeAccess);
    if (options.allGroups !== undefined) {
      if (!(["none", "read", "write"] as const).includes(options.allGroups)) {
        throw invalidRequest("A Zotero all-groups permission is invalid.");
      }
      url.searchParams.set("all_groups", options.allGroups);
    }
  }

  return assertZoteroOAuthProviderUrl(url);
}

export interface ZoteroOAuthRequestCredentials {
  requestToken: string;
  requestTokenSecret: string;
}

export interface ZoteroOAuthAccessCredentials {
  /** Zotero's long-lived API key. It must be encrypted before persistence. */
  accessToken: string;
  userId: string;
}

export interface ZoteroOAuthClientOptions {
  consumerKey: string;
  consumerSecret: string;
  fetchImpl?: typeof fetch;
  /** Returns Unix epoch milliseconds. */
  clock?: () => number;
  nonce?: () => string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface AccessTokenExchangeInput {
  requestToken: string;
  requestTokenSecret: string;
  verifier: string;
}

function assertBoundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidConfiguration(
      `${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
}

function strictTokenResponseParameters(body: string): Map<string, string> {
  const pairs = parseFormPairs(body, () =>
    badResponse("Zotero returned an invalid OAuth token response."),
  );
  if (pairs.length === 0 || pairs.length > MAX_FORM_PARAMETERS) {
    throw badResponse("Zotero returned an invalid OAuth token response.");
  }

  const result = new Map<string, string>();
  for (const [name, value] of pairs) {
    if (
      name.length === 0 ||
      utf8Length(name, badResponse) > MAX_FORM_PARAMETER_BYTES ||
      utf8Length(value, badResponse) > MAX_FORM_PARAMETER_BYTES ||
      result.has(name)
    ) {
      throw badResponse("Zotero returned an invalid OAuth token response.");
    }
    result.set(name, value);
  }
  return result;
}

function requiredResponseValue(
  parameters: ReadonlyMap<string, string>,
  name: string,
  providerStatus?: number,
): string {
  const value = parameters.get(name);
  if (
    value === undefined ||
    value.length === 0 ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    utf8Length(value, badResponse) > MAX_CREDENTIAL_BYTES
  ) {
    throw badResponse(
      "Zotero returned an incomplete OAuth token response.",
      providerStatus,
    );
  }
  return value;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort. It must never replace the normalized error.
  }
}

async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!DECIMAL_INTEGER_PATTERN.test(normalized)) {
      await cancelBody(response);
      throw badResponse("Zotero returned an invalid OAuth response length.", response.status);
    }
    const length = Number(normalized);
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      await cancelBody(response);
      throw badResponse("Zotero returned an oversized OAuth response.", response.status);
    }
  }

  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw badResponse("Zotero returned an oversized OAuth response.", response.status);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof ZoteroOAuthError) throw error;
    throw badResponse("Zotero returned an unreadable OAuth response.", response.status);
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw badResponse("Zotero returned an invalid UTF-8 OAuth response.", response.status);
  }
}

function normalizeProviderStatus(response: Response): ZoteroOAuthError {
  const providerStatus = response.status;
  if ([400, 401, 403].includes(providerStatus)) {
    return new ZoteroOAuthError("Zotero rejected the OAuth exchange.", {
      code: "zotero_oauth_provider_rejected",
      status: 502,
      retryable: false,
      providerStatus,
    });
  }
  if (providerStatus === 408 || providerStatus === 429 || providerStatus >= 500) {
    return new ZoteroOAuthError("Zotero OAuth is temporarily unavailable.", {
      code: "zotero_oauth_unavailable",
      status: 503,
      retryable: true,
      providerStatus,
    });
  }
  return badResponse("Zotero returned an unexpected OAuth response.", providerStatus);
}

function responseMatchesEndpoint(response: Response, endpoint: URL): boolean {
  if (response.redirected) return false;
  if (response.url === "") return true; // Synthetic Response objects used by tests.
  try {
    const responseUrl = assertZoteroOAuthProviderUrl(response.url);
    return responseUrl.toString() === endpoint.toString();
  } catch {
    return false;
  }
}

/**
 * Minimal Zotero OAuth 1.0a exchange client. Credential persistence, callback
 * ownership checks, replay prevention, and API-key encryption stay outside it.
 */
export class ZoteroOAuthClient {
  private readonly consumerKey: string;
  private readonly consumerSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly nonce: () => string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: ZoteroOAuthClientOptions) {
    if (typeof options !== "object" || options === null || Array.isArray(options)) {
      throw invalidConfiguration("Zotero OAuth client options are required.");
    }
    assertString(
      options.consumerKey,
      "A Zotero OAuth consumer key",
      MAX_CREDENTIAL_BYTES,
      invalidConfiguration,
    );
    assertString(
      options.consumerSecret,
      "A Zotero OAuth consumer secret",
      MAX_CREDENTIAL_BYTES,
      invalidConfiguration,
    );

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxResponseBytes =
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    assertBoundedInteger(timeoutMs, "The Zotero OAuth timeout", 1, MAX_TIMEOUT_MS);
    assertBoundedInteger(
      maxResponseBytes,
      "The Zotero OAuth response limit",
      1,
      MAX_RESPONSE_BYTES,
    );
    if (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function") {
      throw invalidConfiguration("The Zotero OAuth fetch implementation is invalid.");
    }
    if (options.clock !== undefined && typeof options.clock !== "function") {
      throw invalidConfiguration("The Zotero OAuth clock is invalid.");
    }
    if (options.nonce !== undefined && typeof options.nonce !== "function") {
      throw invalidConfiguration("The Zotero OAuth nonce source is invalid.");
    }

    this.consumerKey = options.consumerKey;
    this.consumerSecret = options.consumerSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clock = options.clock ?? Date.now;
    this.nonce =
      options.nonce ?? (() => randomBytes(24).toString("base64url"));
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
  }

  async requestTemporaryCredentials(
    callbackUrl: string | URL,
  ): Promise<ZoteroOAuthRequestCredentials> {
    const callback = assertCallbackUrl(callbackUrl);
    const parameters = this.createProtocolParameters([
      ["oauth_callback", callback.toString()],
    ]);
    const response = await this.signedPost(
      ZOTERO_OAUTH_REQUEST_TOKEN_URL,
      parameters,
      "",
    );
    const responseParameters = response.parameters;

    if (responseParameters.get("oauth_callback_confirmed") !== "true") {
      throw badResponse(
        "Zotero did not confirm the OAuth callback.",
        response.providerStatus,
      );
    }

    return {
      requestToken: requiredResponseValue(
        responseParameters,
        "oauth_token",
        response.providerStatus,
      ),
      requestTokenSecret: requiredResponseValue(
        responseParameters,
        "oauth_token_secret",
        response.providerStatus,
      ),
    };
  }

  async exchangeAccessToken(
    input: AccessTokenExchangeInput,
  ): Promise<ZoteroOAuthAccessCredentials> {
    assertString(
      input.requestToken,
      "A Zotero OAuth request token",
      MAX_CREDENTIAL_BYTES,
    );
    assertString(
      input.requestTokenSecret,
      "A Zotero OAuth request token secret",
      MAX_CREDENTIAL_BYTES,
    );
    assertString(
      input.verifier,
      "A Zotero OAuth verifier",
      MAX_CREDENTIAL_BYTES,
    );

    const parameters = this.createProtocolParameters([
      ["oauth_token", input.requestToken],
      ["oauth_verifier", input.verifier],
    ]);
    const response = await this.signedPost(
      ZOTERO_OAUTH_ACCESS_TOKEN_URL,
      parameters,
      input.requestTokenSecret,
    );
    const responseParameters = response.parameters;

    const oauthToken = requiredResponseValue(
      responseParameters,
      "oauth_token",
      response.providerStatus,
    );
    const oauthTokenSecret = requiredResponseValue(
      responseParameters,
      "oauth_token_secret",
      response.providerStatus,
    );
    // Zotero documents both values as the same long-lived API key. Requiring
    // that invariant avoids persisting the wrong half of an ambiguous reply.
    if (oauthToken !== oauthTokenSecret) {
      throw badResponse(
        "Zotero returned inconsistent OAuth access credentials.",
        response.providerStatus,
      );
    }

    const userId = requiredResponseValue(
      responseParameters,
      "userID",
      response.providerStatus,
    );
    if (!/^[1-9][0-9]*$/.test(userId)) {
      throw badResponse(
        "Zotero returned an invalid OAuth user ID.",
        response.providerStatus,
      );
    }

    return { accessToken: oauthTokenSecret, userId };
  }

  private createProtocolParameters(
    additional: readonly OAuthParameter[],
  ): OAuthParameter[] {
    let epochMilliseconds: number;
    let nonce: string;
    try {
      epochMilliseconds = this.clock();
      nonce = this.nonce();
    } catch {
      throw invalidConfiguration("The Zotero OAuth clock or nonce source failed.");
    }

    if (
      !Number.isSafeInteger(epochMilliseconds) ||
      epochMilliseconds < 0 ||
      !Number.isSafeInteger(Math.floor(epochMilliseconds / 1_000))
    ) {
      throw invalidConfiguration("The Zotero OAuth clock returned an invalid time.");
    }
    assertString(
      nonce,
      "The Zotero OAuth nonce",
      MAX_CREDENTIAL_BYTES,
      invalidConfiguration,
    );

    return [
      ["oauth_consumer_key", this.consumerKey],
      ["oauth_nonce", nonce],
      ["oauth_signature_method", "HMAC-SHA1"],
      ["oauth_timestamp", String(Math.floor(epochMilliseconds / 1_000))],
      ["oauth_version", "1.0"],
      ...additional,
    ];
  }

  private async signedPost(
    endpointValue: string,
    parameters: OAuthParameter[],
    tokenSecret: string,
  ): Promise<{ parameters: Map<string, string>; providerStatus: number }> {
    const endpoint = assertZoteroOAuthProviderUrl(endpointValue);
    const signature = signOAuthRequest({
      method: "POST",
      url: endpoint,
      parameters,
      consumerSecret: this.consumerSecret,
      tokenSecret,
    });
    const authorization = buildOAuthAuthorizationHeader([
      ...parameters,
      ["oauth_signature", signature],
    ]);

    const controller = new AbortController();
    const timeoutMarker = Symbol("zotero-oauth-timeout");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof timeoutMarker>((resolve) => {
      timeout = setTimeout(() => {
        resolve(timeoutMarker);
        controller.abort();
      }, this.timeoutMs);
    });

    const requestPromise = (async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: "POST",
          headers: new Headers({
            Accept: "application/x-www-form-urlencoded",
            Authorization: authorization,
          }),
          body: null,
          cache: "no-store",
          credentials: "omit",
          redirect: "manual",
          referrerPolicy: "no-referrer",
          signal: controller.signal,
        });
      } catch {
        throw new ZoteroOAuthError("PaperPilot could not reach Zotero OAuth.", {
          code: "zotero_oauth_unavailable",
          status: 502,
          retryable: true,
        });
      }

      if (!responseMatchesEndpoint(response, endpoint)) {
        await cancelBody(response);
        throw badResponse(
          "Zotero returned an OAuth response from an unexpected URL.",
          response.status,
        );
      }
      if (!response.ok) {
        await cancelBody(response);
        throw normalizeProviderStatus(response);
      }

      const body = await readBoundedResponseBody(
        response,
        this.maxResponseBytes,
      );
      try {
        return {
          parameters: strictTokenResponseParameters(body),
          providerStatus: response.status,
        };
      } catch (error) {
        if (
          error instanceof ZoteroOAuthError &&
          error.providerStatus === undefined
        ) {
          throw new ZoteroOAuthError(error.message, {
            code: error.code,
            status: error.status,
            retryable: error.retryable,
            providerStatus: response.status,
          });
        }
        throw error;
      }
    })();

    try {
      const result = await Promise.race([requestPromise, timeoutPromise]);
      if (result === timeoutMarker) {
        throw new ZoteroOAuthError("The Zotero OAuth request timed out.", {
          code: "zotero_oauth_timeout",
          status: 504,
          retryable: true,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof ZoteroOAuthError) throw error;
      throw new ZoteroOAuthError("PaperPilot could not reach Zotero OAuth.", {
        code: "zotero_oauth_unavailable",
        status: 502,
        retryable: true,
      });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
