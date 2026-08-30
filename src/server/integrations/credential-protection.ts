import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const MAGIC = Buffer.from([0x50, 0x50, 0x43, 0x01]); // PPC + envelope version 1
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_SECRET_BYTES = 64 * 1024;
const BINDING_PATTERN = /^[a-zA-Z0-9._:-]{1,200}$/;

export interface CredentialBinding {
  organizationId: string;
  provider: string;
  /** Connection ID for durable keys, or OAuth-attempt ID for temporary secrets. */
  subjectId: string;
}

export interface ProtectedCredential {
  ciphertext: Uint8Array;
  fingerprint: string;
  keyVersion: string;
}

export interface CredentialKeyring {
  activeVersion: string;
  encryptionKeys: Readonly<Record<string, Uint8Array>>;
  fingerprintKey: Uint8Array;
}

export interface CredentialProtector {
  protect(secret: string, binding: CredentialBinding): ProtectedCredential;
  reveal(
    ciphertext: Uint8Array,
    keyVersion: string,
    binding: CredentialBinding,
  ): string;
  fingerprint(secret: string): string;
}

export class CredentialProtectionError extends Error {
  readonly code: "invalid_configuration" | "invalid_credential" | "credential_unavailable";

  constructor(
    code: CredentialProtectionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "CredentialProtectionError";
    this.code = code;
  }
}

function configurationError(message: string): never {
  throw new CredentialProtectionError("invalid_configuration", message);
}

function credentialError(message: string): never {
  throw new CredentialProtectionError("invalid_credential", message);
}

function unavailable(): never {
  // Authentication failures, an unknown key version, and a wrong binding are
  // intentionally indistinguishable to callers and logs.
  throw new CredentialProtectionError(
    "credential_unavailable",
    "The protected integration credential is unavailable.",
  );
}

function normalizedBinding(binding: CredentialBinding): CredentialBinding {
  for (const field of ["organizationId", "provider", "subjectId"] as const) {
    const value = binding?.[field];
    if (typeof value !== "string" || !BINDING_PATTERN.test(value)) {
      credentialError(`${field} must be an opaque identifier containing 1 to 200 safe characters.`);
    }
  }
  return {
    organizationId: binding.organizationId,
    provider: binding.provider.toLowerCase(),
    subjectId: binding.subjectId,
  };
}

function associatedData(binding: CredentialBinding): Buffer {
  const normalized = normalizedBinding(binding);
  return Buffer.from(JSON.stringify({
    envelope: 1,
    organizationId: normalized.organizationId,
    provider: normalized.provider,
    subjectId: normalized.subjectId,
  }), "utf8");
}

function secretBytes(secret: string): Buffer {
  if (typeof secret !== "string") credentialError("Credential plaintext must be text.");
  const value = Buffer.from(secret, "utf8");
  if (value.byteLength < 1 || value.byteLength > MAX_SECRET_BYTES) {
    credentialError(`Credential plaintext must contain 1 to ${MAX_SECRET_BYTES} UTF-8 bytes.`);
  }
  return value;
}

function ownedKey(value: Uint8Array, label: string): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== KEY_BYTES) {
    configurationError(`${label} must contain exactly ${KEY_BYTES} bytes.`);
  }
  return Buffer.from(value);
}

function safeVersion(value: string, label: string): string {
  if (typeof value !== "string" || !BINDING_PATTERN.test(value)) {
    configurationError(`${label} must contain 1 to 200 safe characters.`);
  }
  return value;
}

/**
 * AES-256-GCM credential envelopes with external key version metadata.
 *
 * Ciphertext is authenticated against the tenant, provider, and owning
 * connection/attempt. Copying bytes to another database row therefore fails
 * closed even when both rows use the same encryption-key version.
 */
export function createCredentialProtector(keyring: CredentialKeyring): CredentialProtector {
  const activeVersion = safeVersion(keyring.activeVersion, "activeVersion");
  const keys = new Map<string, Buffer>();
  for (const [version, key] of Object.entries(keyring.encryptionKeys)) {
    keys.set(safeVersion(version, "encryption key version"), ownedKey(key, `encryptionKeys.${version}`));
  }
  if (!keys.has(activeVersion)) {
    configurationError("activeVersion must identify a configured encryption key.");
  }
  const fingerprintKey = ownedKey(keyring.fingerprintKey, "fingerprintKey");

  function fingerprint(secret: string): string {
    return `hmac-sha256:${createHmac("sha256", fingerprintKey)
      .update("paperpilot:credential-fingerprint:v1\0", "utf8")
      .update(secretBytes(secret))
      .digest("hex")}`;
  }

  return {
    protect(secret, binding) {
      const plaintext = secretBytes(secret);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", keys.get(activeVersion)!, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(associatedData(binding));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        ciphertext: Buffer.concat([MAGIC, nonce, tag, encrypted]),
        fingerprint: fingerprint(secret),
        keyVersion: activeVersion,
      };
    },

    reveal(ciphertext, keyVersion, binding) {
      if (!(ciphertext instanceof Uint8Array)) return unavailable();
      const envelope = Buffer.from(ciphertext);
      if (
        envelope.byteLength <= MAGIC.byteLength + NONCE_BYTES + AUTH_TAG_BYTES
        || !envelope.subarray(0, MAGIC.byteLength).equals(MAGIC)
      ) {
        return unavailable();
      }
      const key = keys.get(keyVersion);
      if (!key) return unavailable();
      const nonceStart = MAGIC.byteLength;
      const tagStart = nonceStart + NONCE_BYTES;
      const contentStart = tagStart + AUTH_TAG_BYTES;
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          envelope.subarray(nonceStart, tagStart),
          { authTagLength: AUTH_TAG_BYTES },
        );
        decipher.setAAD(associatedData(binding));
        decipher.setAuthTag(envelope.subarray(tagStart, contentStart));
        const plaintext = Buffer.concat([
          decipher.update(envelope.subarray(contentStart)),
          decipher.final(),
        ]);
        if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_SECRET_BYTES) {
          return unavailable();
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      } catch {
        return unavailable();
      }
    },

    fingerprint,
  };
}

function decodeKey(value: string | undefined, label: string): Uint8Array {
  if (!value?.trim()) configurationError(`${label} is required.`);
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    configurationError(`${label} must be base64 or base64url.`);
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64");
  return ownedKey(decoded, label);
}

/** Build a rotation-capable protector from secret-manager supplied env data. */
export function credentialProtectorFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CredentialProtector {
  const activeVersion = safeVersion(
    environment.PAPERPILOT_CREDENTIAL_ACTIVE_KEY_VERSION ?? "",
    "PAPERPILOT_CREDENTIAL_ACTIVE_KEY_VERSION",
  );
  let encodedKeys: unknown;
  try {
    encodedKeys = JSON.parse(environment.PAPERPILOT_CREDENTIAL_ENCRYPTION_KEYS ?? "");
  } catch {
    configurationError("PAPERPILOT_CREDENTIAL_ENCRYPTION_KEYS must be a JSON object.");
  }
  if (!encodedKeys || typeof encodedKeys !== "object" || Array.isArray(encodedKeys)) {
    configurationError("PAPERPILOT_CREDENTIAL_ENCRYPTION_KEYS must be a JSON object.");
  }

  const encryptionKeys: Record<string, Uint8Array> = {};
  for (const [version, encoded] of Object.entries(encodedKeys as Record<string, unknown>)) {
    if (typeof encoded !== "string") {
      configurationError(`Encryption key ${version} must be encoded text.`);
    }
    encryptionKeys[version] = decodeKey(encoded, `encryption key ${version}`);
  }
  return createCredentialProtector({
    activeVersion,
    encryptionKeys,
    fingerprintKey: decodeKey(
      environment.PAPERPILOT_CREDENTIAL_FINGERPRINT_KEY,
      "PAPERPILOT_CREDENTIAL_FINGERPRINT_KEY",
    ),
  });
}
