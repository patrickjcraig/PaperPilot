import type { BetterAuthOptions } from "better-auth";
import { findInvalidTrustedProxies } from "@better-auth/core/utils/ip";

type BetterAuthIpAddressConfig = NonNullable<
  NonNullable<BetterAuthOptions["advanced"]>["ipAddress"]
>;

function commaSeparatedEnvironment(name: string): string[] | undefined {
  const configured = process.env[name]?.trim();
  if (!configured) return undefined;
  const entries = configured.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 ? Array.from(new Set(entries)) : undefined;
}

function configuredIpv6Subnet(): number | undefined {
  const value = process.env.PAPERPILOT_IPV6_RATE_LIMIT_SUBNET?.trim();
  if (!value) return undefined;
  const subnet = Number(value);
  if (!Number.isInteger(subnet) || subnet < 1 || subnet > 128) {
    throw new Error("PAPERPILOT_IPV6_RATE_LIMIT_SUBNET must be an integer from 1 to 128.");
  }
  return subnet;
}

const ipAddressHeaders = commaSeparatedEnvironment("PAPERPILOT_IP_ADDRESS_HEADERS");
if (ipAddressHeaders?.some((header) => !/^[a-z0-9-]+$/.test(header))) {
  throw new Error("PAPERPILOT_IP_ADDRESS_HEADERS contains an invalid HTTP header name.");
}

const trustedProxies = commaSeparatedEnvironment("PAPERPILOT_TRUSTED_PROXIES");
const invalidTrustedProxies = findInvalidTrustedProxies(trustedProxies ?? []);
if (invalidTrustedProxies.length > 0) {
  throw new Error(
    `PAPERPILOT_TRUSTED_PROXIES contains invalid IP/CIDR entries: ${invalidTrustedProxies.join(", ")}.`,
  );
}

/** Shared IP resolution for Better Auth and application route limiters. */
export const paperPilotIpAddressConfig = {
  ...(ipAddressHeaders ? { ipAddressHeaders } : {}),
  ...(trustedProxies ? { trustedProxies } : {}),
  ...(configuredIpv6Subnet() !== undefined ? { ipv6Subnet: configuredIpv6Subnet() } : {}),
} satisfies BetterAuthIpAddressConfig;

/**
 * Better Auth 1.7.2 includes atomic conditional increments in its Prisma
 * database storage path. Credential endpoints retain Better Auth's stricter
 * built-in rules (3 attempts per 10 or 60 seconds); this is the default budget
 * for all other auth paths.
 */
export const betterAuthRateLimitConfig = {
  enabled: true,
  storage: "database",
  window: 60,
  max: 300,
} satisfies NonNullable<BetterAuthOptions["rateLimit"]>;
