import "server-only";

import { HttpProblem } from "@/server/http/problem";

const MAX_CALLBACK_QUERY_BYTES = 16 * 1024;
const MAX_CALLBACK_VALUE_BYTES = 4 * 1024;
const CALLBACK_QUERY_KEYS = new Set([
  "state",
  "oauth_token",
  "oauth_verifier",
]);
const CONTROL_OR_WHITESPACE_PATTERN = /[\s\u007F]/u;

export interface ZoteroOAuthCallbackParameters {
  state: string;
  requestToken: string;
  verifier: string;
}

function invalidCallback(): never {
  throw new HttpProblem(
    400,
    "validation",
    "The Zotero OAuth callback is invalid.",
  );
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return invalidCallback();
  }
}

function boundedValue(value: string | undefined): string {
  if (
    !value ||
    CONTROL_OR_WHITESPACE_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_CALLBACK_VALUE_BYTES
  ) {
    return invalidCallback();
  }
  return value;
}

/** Strictly parses the provider's three required, single-valued callback fields. */
export function parseZoteroOAuthCallbackRequest(
  request: Request,
): ZoteroOAuthCallbackParameters {
  if (request.method !== "GET") return invalidCallback();
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return invalidCallback();
  }
  const serialized = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  if (
    !serialized ||
    url.hash !== "" ||
    Buffer.byteLength(serialized, "utf8") > MAX_CALLBACK_QUERY_BYTES
  ) {
    return invalidCallback();
  }

  const parameters = new Map<string, string>();
  for (const part of serialized.split("&")) {
    if (!part) return invalidCallback();
    const separator = part.indexOf("=");
    const encodedName = separator < 0 ? part : part.slice(0, separator);
    const encodedValue = separator < 0 ? "" : part.slice(separator + 1);
    const name = decodeFormComponent(encodedName);
    const value = decodeFormComponent(encodedValue);
    if (!CALLBACK_QUERY_KEYS.has(name) || parameters.has(name)) {
      return invalidCallback();
    }
    parameters.set(name, boundedValue(value));
  }
  if (parameters.size !== CALLBACK_QUERY_KEYS.size) return invalidCallback();

  return {
    state: boundedValue(parameters.get("state")),
    requestToken: boundedValue(parameters.get("oauth_token")),
    verifier: boundedValue(parameters.get("oauth_verifier")),
  };
}

/** A callback redirect never reflects provider or database values. */
export function zoteroOAuthCallbackRedirect(
  location: URL,
  requestId: string,
): Response {
  if (location.protocol !== "https:" || location.username || location.password) {
    throw new Error("The Zotero OAuth result redirect must be a safe HTTPS URL.");
  }
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: location.toString(),
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Request-Id": requestId,
    },
  });
}

/** Fixed same-origin fallback used even when all server OAuth config is broken. */
export function zoteroOAuthUnavailableCallbackRedirect(
  requestId: string,
): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: "/app?zotero=failed#sources",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Request-Id": requestId,
    },
  });
}
