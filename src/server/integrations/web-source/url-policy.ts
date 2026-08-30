import "server-only";

import { isIP } from "node:net";

export const MAX_WEB_SOURCE_URL_BYTES = 2_048;
export const MAX_WEB_SOURCE_ORIGIN_BYTES = 255;
export const MAX_WEB_SOURCE_PATH_PREFIX_BYTES = 1_024;

const PUBLIC_DNS_NAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BLOCKED_DNS_SUFFIXES = [
  ".arpa",
  ".corp",
  ".example",
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localdomain",
  ".localhost",
  ".onion",
  ".test",
] as const;
const ENCODED_CONTROL_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const ENCODED_PATH_SEPARATOR_PATTERN = /%(?:2f|5c)/i;
const ENCODED_DOT_PATTERN = /%2e/i;

export type WebSourceUrlPolicyErrorCode =
  | "invalid_url"
  | "url_too_long"
  | "https_required"
  | "credentials_forbidden"
  | "fragment_forbidden"
  | "public_dns_required"
  | "ambiguous_path_forbidden"
  | "invalid_policy_path"
  | "private_address_forbidden";

export class WebSourceUrlPolicyError extends TypeError {
  constructor(
    readonly code: WebSourceUrlPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebSourceUrlPolicyError";
  }
}

export interface CanonicalWebSourceUrl {
  url: string;
  origin: string;
  hostname: string;
  pathname: string;
  pathAndQuery: string;
}

export interface WebSourcePolicyBoundary {
  origin: string;
  pathPrefix: string;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function fail(code: WebSourceUrlPolicyErrorCode, message: string): never {
  throw new WebSourceUrlPolicyError(code, message);
}

function requireUnambiguousRawUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail("invalid_url", "A canonical absolute source URL is required.");
  }
  if (byteLength(value) > MAX_WEB_SOURCE_URL_BYTES) {
    fail("url_too_long", "The source URL exceeds the supported length.");
  }
  if (
    value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
    || ENCODED_CONTROL_PATTERN.test(value)
    || ENCODED_PATH_SEPARATOR_PATTERN.test(value)
    || ENCODED_DOT_PATTERN.test(value)
  ) {
    fail("ambiguous_path_forbidden", "The source URL contains ambiguous path bytes.");
  }
  return value;
}

function requirePublicDnsHostname(hostname: string): string {
  const canonical = hostname.toLowerCase();
  if (
    canonical === "localhost"
    || canonical.endsWith(".")
    || isIP(canonical) !== 0
    || !PUBLIC_DNS_NAME_PATTERN.test(canonical)
    || BLOCKED_DNS_SUFFIXES.some(
      (suffix) => canonical === suffix.slice(1) || canonical.endsWith(suffix),
    )
  ) {
    fail("public_dns_required", "The source URL must use an eligible public DNS hostname.");
  }
  return canonical;
}

function requireUnambiguousPath(url: URL): void {
  if (
    ENCODED_PATH_SEPARATOR_PATTERN.test(url.pathname)
    || ENCODED_DOT_PATTERN.test(url.pathname)
  ) {
    fail(
      "ambiguous_path_forbidden",
      "Encoded separators and dot segments are not accepted in source paths.",
    );
  }
}

export function canonicalizePublicWebSourceUrl(value: unknown): CanonicalWebSourceUrl {
  const raw = requireUnambiguousRawUrl(value);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    fail("invalid_url", "A canonical absolute source URL is required.");
  }
  if (parsed.protocol !== "https:") {
    fail("https_required", "Web source URLs must use HTTPS.");
  }
  if (parsed.username || parsed.password) {
    fail("credentials_forbidden", "Credentials are not accepted in source URLs.");
  }
  if (parsed.hash) {
    fail("fragment_forbidden", "Source URL fragments are not accepted.");
  }
  const hostname = requirePublicDnsHostname(parsed.hostname);
  requireUnambiguousPath(parsed);
  parsed.hostname = hostname;
  const origin = parsed.origin;
  if (byteLength(origin) > MAX_WEB_SOURCE_ORIGIN_BYTES) {
    fail("invalid_url", "The source origin exceeds the supported length.");
  }
  return {
    url: parsed.href,
    origin,
    hostname,
    pathname: parsed.pathname,
    pathAndQuery: `${parsed.pathname}${parsed.search}`,
  };
}

export function canonicalizeWebSourcePolicyOrigin(value: unknown): string {
  const canonical = canonicalizePublicWebSourceUrl(value);
  if (canonical.pathname !== "/" || canonical.pathAndQuery !== "/") {
    fail("invalid_url", "A policy origin cannot contain a path or query.");
  }
  return canonical.origin;
}

export function canonicalizeWebSourcePolicyPathPrefix(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || !value.startsWith("/")
    || value.includes("?")
    || value.includes("#")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
    || ENCODED_CONTROL_PATTERN.test(value)
    || ENCODED_PATH_SEPARATOR_PATTERN.test(value)
    || ENCODED_DOT_PATTERN.test(value)
    || byteLength(value) > MAX_WEB_SOURCE_PATH_PREFIX_BYTES
  ) {
    fail("invalid_policy_path", "The policy path prefix is invalid.");
  }
  const parsed = new URL(value, "https://policy.paperpilot.invalid");
  if (parsed.search || parsed.hash || parsed.pathname !== value) {
    fail("invalid_policy_path", "The policy path prefix must already be canonical.");
  }
  if (value === "/") return value;
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function webSourceUrlMatchesPolicy(
  candidate: CanonicalWebSourceUrl,
  boundary: WebSourcePolicyBoundary,
): boolean {
  const origin = canonicalizeWebSourcePolicyOrigin(boundary.origin);
  const pathPrefix = canonicalizeWebSourcePolicyPathPrefix(boundary.pathPrefix);
  if (candidate.origin !== origin) return false;
  if (pathPrefix === "/") return true;
  return candidate.pathname === pathPrefix || candidate.pathname.startsWith(`${pathPrefix}/`);
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every(
    (octet, index) => Number.isInteger(octet)
      && octet >= 0
      && octet <= 255
      && String(octet) === parts[index],
  ) ? octets : null;
}

function isPublicIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (!value) return false;
  const [a, b, c] = value;
  if (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224
  ) return false;
  return true;
}

function ipv6Bytes(address: string): Uint8Array | null {
  let raw = address.toLowerCase();
  if (raw.includes("%")) return null;
  const ipv4Tail = raw.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (ipv4Tail) {
    const octets = parseIpv4(ipv4Tail);
    if (!octets) return null;
    const replacement = `${((octets[0] << 8) | octets[1]).toString(16)}:${(
      (octets[2] << 8) | octets[3]
    ).toString(16)}`;
    raw = `${raw.slice(0, raw.length - ipv4Tail.length)}${replacement}`;
  }
  if ((raw.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = raw.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((raw.includes("::") && missing < 1) || (!raw.includes("::") && missing !== 0)) return null;
  const groups = raw.includes("::")
    ? [...left, ...Array.from({ length: missing }, () => "0"), ...right]
    : left;
  if (
    groups.length !== 8
    || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    const group = Number.parseInt(groups[index], 16);
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  }
  return bytes;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  // Only globally routed 2000::/3 addresses are eligible. Explicitly reject
  // documentation, benchmarking, ORCHID, Teredo, and 6to4 sub-ranges too.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  if (
    hasPrefix(bytes, [0x20, 0x01, 0x00, 0x00])
    || hasPrefix(bytes, [0x20, 0x01, 0x00, 0x02, 0x00, 0x00])
    || hasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8])
    || (hasPrefix(bytes, [0x20, 0x01, 0x00]) && (bytes[3] & 0xf0) === 0x10)
    || (hasPrefix(bytes, [0x20, 0x01, 0x00]) && (bytes[3] & 0xf0) === 0x20)
    || hasPrefix(bytes, [0x20, 0x02])
  ) return false;
  return true;
}

export function isPublicWebSourceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

export function requirePublicWebSourceAddresses(addresses: readonly string[]): readonly string[] {
  if (addresses.length === 0 || addresses.some((address) => !isPublicWebSourceAddress(address))) {
    fail(
      "private_address_forbidden",
      "The source hostname did not resolve exclusively to eligible public addresses.",
    );
  }
  return addresses;
}
