import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  CredentialProtectionError,
  createCredentialProtector,
  credentialProtectorFromEnvironment,
  type CredentialBinding,
} from "./credential-protection";

const keyOne = randomBytes(32);
const keyTwo = randomBytes(32);
const fingerprintKey = randomBytes(32);
const binding: CredentialBinding = {
  organizationId: "workspace-one",
  provider: "ZOTERO",
  subjectId: "connection-one",
};

function protector(activeVersion = "v2") {
  return createCredentialProtector({
    activeVersion,
    encryptionKeys: { v1: keyOne, v2: keyTwo },
    fingerprintKey,
  });
}

test("credential envelopes are randomized, decryptable, and stably fingerprinted", () => {
  const service = protector();
  const first = service.protect("zotero-secret-key", binding);
  const second = service.protect("zotero-secret-key", binding);

  assert.equal(first.keyVersion, "v2");
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.match(first.fingerprint, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(service.reveal(first.ciphertext, first.keyVersion, binding), "zotero-secret-key");
});

test("old key versions remain readable during rotation", () => {
  const oldEnvelope = protector("v1").protect("temporary-request-secret", binding);
  assert.equal(
    protector("v2").reveal(oldEnvelope.ciphertext, oldEnvelope.keyVersion, binding),
    "temporary-request-secret",
  );
});

test("tampering, copied-row bindings, and unknown versions fail identically", () => {
  const service = protector();
  const protectedValue = service.protect("credential-value", binding);
  const tampered = Uint8Array.from(protectedValue.ciphertext);
  tampered[tampered.length - 1] ^= 0xff;
  const wrongBinding = { ...binding, subjectId: "connection-two" };

  for (const action of [
    () => service.reveal(tampered, protectedValue.keyVersion, binding),
    () => service.reveal(protectedValue.ciphertext, protectedValue.keyVersion, wrongBinding),
    () => service.reveal(protectedValue.ciphertext, "missing", binding),
  ]) {
    assert.throws(
      action,
      (error: unknown) => error instanceof CredentialProtectionError
        && error.code === "credential_unavailable"
        && !error.message.includes("credential-value"),
    );
  }
});

test("environment keyrings accept base64url and fail closed when incomplete", () => {
  const fromEnvironment = credentialProtectorFromEnvironment({
    PAPERPILOT_CREDENTIAL_ACTIVE_KEY_VERSION: "v1",
    PAPERPILOT_CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ v1: keyOne.toString("base64url") }),
    PAPERPILOT_CREDENTIAL_FINGERPRINT_KEY: fingerprintKey.toString("base64"),
  });
  const protectedValue = fromEnvironment.protect("configured-secret", binding);
  assert.equal(
    fromEnvironment.reveal(protectedValue.ciphertext, protectedValue.keyVersion, binding),
    "configured-secret",
  );

  assert.throws(
    () => credentialProtectorFromEnvironment({}),
    (error: unknown) => error instanceof CredentialProtectionError
      && error.code === "invalid_configuration",
  );
});

test("credential and binding bounds are enforced before encryption", () => {
  const service = protector();
  assert.throws(() => service.protect("", binding), /Credential plaintext/);
  assert.throws(
    () => service.protect("secret", { ...binding, subjectId: "unsafe/value" }),
    /subjectId/,
  );
  assert.throws(
    () => createCredentialProtector({
      activeVersion: "v1",
      encryptionKeys: { v1: randomBytes(16) },
      fingerprintKey,
    }),
    /exactly 32 bytes/,
  );
});
