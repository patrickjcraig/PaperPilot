import assert from "node:assert/strict";
import test from "node:test";

import {
  EMAIL_VERIFICATION_CALLBACK_PATH,
  PASSWORD_RESET_CALLBACK_PATH,
  SELF_SERVICE_ACCOUNT_DELETION_ENABLED,
  emailVerificationCallbackPath,
  invitationAwareApplicationPath,
  invitationAwareAuthPath,
  invitationIdFromApplicationUrl,
  isEmailVerificationCallbackPath,
  normalizeWorkspaceInvitationId,
  resetLinkStateFromUrl,
  shouldDisableProductionSignUp,
} from "./auth-flow";

const token = "A1b2C3d4E5f6G7h8I9j0K1l2";
const invitationId = "123e4567-e89b-42d3-a456-426614174000";

test("self-service account deletion stays closed until PaperPilot owns erasure", () => {
  assert.equal(SELF_SERVICE_ACCOUNT_DELETION_ENABLED, false);
});

test("production signup remains closed until transactional delivery is configured", () => {
  assert.equal(shouldDisableProductionSignUp(true, false), true);
  assert.equal(shouldDisableProductionSignUp(true, true), false);
  assert.equal(shouldDisableProductionSignUp(false, false), false);
});

test("invitation-aware authentication paths preserve only one bounded opaque invitation", () => {
  assert.equal(normalizeWorkspaceInvitationId(invitationId), invitationId);
  assert.equal(normalizeWorkspaceInvitationId("short"), null);
  assert.equal(normalizeWorkspaceInvitationId(`${invitationId}\u202e`), null);
  assert.equal(
    invitationAwareAuthPath("/sign-in", invitationId),
    `/sign-in?invitation=${invitationId}`,
  );
  assert.equal(
    invitationAwareApplicationPath(invitationId),
    `/app?invitation=${invitationId}#collaboration`,
  );
  assert.equal(
    invitationIdFromApplicationUrl(
      `https://paperpilot.example/sign-up?invitation=${invitationId}`,
      "https://paperpilot.example",
    ),
    invitationId,
  );
  assert.equal(
    invitationIdFromApplicationUrl(
      `https://attacker.example/sign-in?invitation=${invitationId}`,
      "https://paperpilot.example",
    ),
    null,
  );
  assert.equal(
    invitationIdFromApplicationUrl(
      `https://paperpilot.example/sign-in?invitation=${invitationId}&invitation=${invitationId}`,
      "https://paperpilot.example",
    ),
    null,
  );
});

test("verification callbacks accept only the canonical invitation continuation", () => {
  assert.equal(isEmailVerificationCallbackPath(EMAIL_VERIFICATION_CALLBACK_PATH), true);
  const callback = emailVerificationCallbackPath(invitationId);
  assert.equal(callback, `/sign-in?verified=1&invitation=${invitationId}`);
  assert.equal(isEmailVerificationCallbackPath(callback), true);
  for (const invalid of [
    `/sign-in?invitation=${invitationId}&verified=1`,
    `/sign-in?verified=1&invitation=${invitationId}&next=https://attacker.example`,
    `/sign-up?verified=1&invitation=${invitationId}`,
    "/sign-in?verified=1&invitation=short",
  ]) assert.equal(isEmailVerificationCallbackPath(invalid), false);
});

test("reset links accept fragment tokens and return a token-free history path", () => {
  assert.deepEqual(
    resetLinkStateFromUrl(
      `https://paperpilot.example/reset-password#token=${token}`,
      "https://paperpilot.example",
    ),
    { token, cleanPath: PASSWORD_RESET_CALLBACK_PATH },
  );
});

test("reset links retain compatibility with Better Auth query callbacks", () => {
  assert.deepEqual(
    resetLinkStateFromUrl(
      `https://paperpilot.example/reset-password?token=${token}`,
      "https://paperpilot.example",
    ),
    { token, cleanPath: PASSWORD_RESET_CALLBACK_PATH },
  );
});

test("reset links fail closed for foreign origins, provider errors, and ambiguous tokens", () => {
  for (const value of [
    `https://attacker.example/reset-password#token=${token}`,
    `https://paperpilot.example/reset-password?error=INVALID_TOKEN#token=${token}`,
    `https://paperpilot.example/reset-password?token=${token}#token=${token}`,
    "https://paperpilot.example/reset-password#token=not-a-token",
  ]) {
    const result = resetLinkStateFromUrl(value, "https://paperpilot.example");
    assert.equal(result.token, null);
    assert.equal(result.cleanPath, PASSWORD_RESET_CALLBACK_PATH);
    assert.equal(result.cleanPath.includes(token), false);
  }
});
