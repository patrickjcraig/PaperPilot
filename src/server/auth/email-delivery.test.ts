import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthEmailDelivery,
  createWebhookTransactionalEmailDelivery,
  webhookEmailConfigurationFromEnvironment,
  type TransactionalEmail,
} from "./email-delivery";

const applicationOrigin = "https://paperpilot.example";
const resetToken = "A1b2C3d4E5f6G7h8I9j0K1l2";
const verificationToken = `${"a".repeat(48)}.${"b".repeat(48)}.${"c".repeat(48)}`;
const webhookSecret = "0123456789abcdef".repeat(2);

function resetUrl(origin = applicationOrigin, token = resetToken): string {
  return `${origin}/api/auth/reset-password/${token}?callbackURL=${encodeURIComponent("/reset-password")}`;
}

function verificationUrl(
  origin = applicationOrigin,
  token = verificationToken,
  callbackPath = "/sign-in?verified=1",
): string {
  const callback = encodeURIComponent(callbackPath);
  return `${origin}/api/auth/verify-email?token=${token}&callbackURL=${callback}`;
}

test("webhook configuration is all-or-nothing and requires a credential-free HTTPS URL", () => {
  assert.equal(webhookEmailConfigurationFromEnvironment({}), null);
  assert.throws(
    () => webhookEmailConfigurationFromEnvironment({
      PAPERPILOT_EMAIL_WEBHOOK_URL: "https://mailer.example/events",
    }),
    /must be configured together/,
  );
  assert.throws(
    () => webhookEmailConfigurationFromEnvironment({
      PAPERPILOT_EMAIL_WEBHOOK_URL: "http://mailer.example/events",
      PAPERPILOT_EMAIL_WEBHOOK_SECRET: webhookSecret,
      PAPERPILOT_EMAIL_FROM: "accounts@paperpilot.example",
    }),
    /must be HTTPS/,
  );
  assert.throws(
    () => webhookEmailConfigurationFromEnvironment({
      PAPERPILOT_EMAIL_WEBHOOK_URL: "https://mailer.example/events?secret=in-url",
      PAPERPILOT_EMAIL_WEBHOOK_SECRET: webhookSecret,
      PAPERPILOT_EMAIL_FROM: "accounts@paperpilot.example",
    }),
    /cannot contain credentials, a query, or a fragment/,
  );
  assert.throws(
    () => webhookEmailConfigurationFromEnvironment({
      PAPERPILOT_EMAIL_WEBHOOK_URL: "https://mailer.example/events",
      PAPERPILOT_EMAIL_WEBHOOK_SECRET: "s".repeat(32),
      PAPERPILOT_EMAIL_FROM: "accounts@paperpilot.example",
    }),
    /high-entropy secret/,
  );

  const configuration = webhookEmailConfigurationFromEnvironment({
    PAPERPILOT_EMAIL_WEBHOOK_URL: "https://mailer.example/v1/events",
    PAPERPILOT_EMAIL_WEBHOOK_SECRET: webhookSecret,
    PAPERPILOT_EMAIL_FROM: "accounts@paperpilot.example",
  });
  assert.equal(configuration?.endpoint.href, "https://mailer.example/v1/events");
  assert.equal(configuration?.from, "accounts@paperpilot.example");
});

test("webhook delivery uses a bearer header, refuses redirects, and emits the neutral contract", async () => {
  let requestUrl: string | undefined;
  let requestInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    requestUrl = input.toString();
    requestInit = init;
    return new Response(null, { status: 202 });
  };
  const configuration = {
    endpoint: new URL("https://mailer.example/v1/events"),
    bearerToken: webhookSecret,
    from: "accounts@paperpilot.example",
  };
  const delivery = createWebhookTransactionalEmailDelivery(configuration, { fetchImpl });
  const message: TransactionalEmail = {
    kind: "password-reset",
    to: "researcher@example.edu",
    subject: "Reset your PaperPilot password",
    text: "Reset message",
    html: "<p>Reset message</p>",
  };

  await delivery.deliver(message);

  assert.equal(requestUrl, configuration.endpoint.href);
  assert.equal(requestInit?.method, "POST");
  assert.equal(requestInit?.redirect, "error");
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${configuration.bearerToken}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(typeof requestInit?.body, "string");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    schemaVersion: 1,
    message: {
      ...message,
      from: configuration.from,
    },
  });
});

test("auth delivery validates its Better Auth origin and callback before sending", async () => {
  const delivered: TransactionalEmail[] = [];
  const authDelivery = createAuthEmailDelivery(applicationOrigin, {
    async deliver(message) {
      delivered.push(message);
    },
  });

  await authDelivery.sendVerification({
    email: "researcher@example.edu",
    name: "Researcher <One>",
    url: verificationUrl(),
    token: verificationToken,
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, "email-verification");
  assert.match(delivered[0].text, new RegExp(verificationToken.replaceAll(".", "\\.")));
  assert.match(delivered[0].html, /Researcher &lt;One&gt;/);

  await assert.rejects(
    authDelivery.sendVerification({
      email: "researcher@example.edu",
      name: "Researcher",
      url: verificationUrl("https://attacker.example"),
      token: verificationToken,
    }),
    (error: unknown) => {
      assert.equal(String(error).includes(verificationToken), false);
      return /invalid authentication link/.test(String(error));
    },
  );
  await assert.rejects(
    authDelivery.sendVerification({
      email: "researcher@example.edu",
      name: "Researcher",
      url: `${applicationOrigin}/api/auth/verify-email?token=${verificationToken}`
        + `&callbackURL=${encodeURIComponent("https://attacker.example/callback")}`,
      token: verificationToken,
    }),
    (error: unknown) => {
      assert.equal(String(error).includes(verificationToken), false);
      return /invalid authentication link/.test(String(error));
    },
  );
  assert.equal(delivered.length, 1);
});

test("auth delivery preserves only a canonical workspace invitation continuation", async () => {
  const delivered: TransactionalEmail[] = [];
  const invitationId = "123e4567-e89b-42d3-a456-426614174000";
  const authDelivery = createAuthEmailDelivery(applicationOrigin, {
    async deliver(message) {
      delivered.push(message);
    },
  });

  await authDelivery.sendVerification({
    email: "invitee@example.test",
    name: "Invited Researcher",
    url: verificationUrl(
      applicationOrigin,
      verificationToken,
      `/sign-in?verified=1&invitation=${invitationId}`,
    ),
    token: verificationToken,
  });
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, new RegExp(`invitation%3D${invitationId}`));

  for (const callbackPath of [
    `/sign-in?invitation=${invitationId}&verified=1`,
    `/sign-in?verified=1&invitation=${invitationId}&next=https://attacker.example`,
    "/sign-in?verified=1&invitation=short",
  ]) {
    await assert.rejects(
      authDelivery.sendVerification({
        email: "invitee@example.test",
        name: "Invited Researcher",
        url: verificationUrl(applicationOrigin, verificationToken, callbackPath),
        token: verificationToken,
      }),
      /invalid authentication link/i,
    );
  }
  assert.equal(delivered.length, 1);
});

test("password reset delivery converts the Better Auth callback to a fragment-only UI link", async () => {
  const delivered: TransactionalEmail[] = [];
  const authDelivery = createAuthEmailDelivery(applicationOrigin, {
    async deliver(message) {
      delivered.push(message);
    },
  });

  await authDelivery.sendPasswordReset({
    email: "researcher@example.edu",
    name: "Researcher",
    url: resetUrl(),
    token: resetToken,
  });

  assert.equal(delivered.length, 1);
  assert.match(
    delivered[0].text,
    new RegExp(`/reset-password#token=${resetToken}`),
  );
  assert.equal(delivered[0].text.includes(`/api/auth/reset-password/${resetToken}`), false);
  assert.equal(delivered[0].text.includes(`?token=${resetToken}`), false);
});

test("provider failures are reduced to a token-free error", async () => {
  const configuration = {
    endpoint: new URL("https://mailer.example/v1/events"),
    bearerToken: webhookSecret,
    from: "accounts@paperpilot.example",
  };
  const fetchImpl: typeof fetch = async () => {
    throw new Error(`provider echoed ${resetToken}`);
  };
  const authDelivery = createAuthEmailDelivery(
    applicationOrigin,
    createWebhookTransactionalEmailDelivery(configuration, { fetchImpl }),
  );

  await assert.rejects(
    authDelivery.sendPasswordReset({
      email: "researcher@example.edu",
      name: "Researcher",
      url: resetUrl(),
      token: resetToken,
    }),
    (error: unknown) => {
      assert.equal(String(error), "TransactionalEmailDeliveryError: Transactional email delivery failed.");
      assert.equal(String(error).includes(resetToken), false);
      return true;
    },
  );

  const alternateAdapter = createAuthEmailDelivery(applicationOrigin, {
    async deliver() {
      throw new Error(`alternate adapter echoed ${resetToken}`);
    },
  });
  await assert.rejects(
    alternateAdapter.sendPasswordReset({
      email: "researcher@example.edu",
      name: "Researcher",
      url: resetUrl(),
      token: resetToken,
    }),
    (error: unknown) => {
      assert.equal(String(error), "TransactionalEmailDeliveryError: Transactional email delivery failed.");
      assert.equal(String(error).includes(resetToken), false);
      return true;
    },
  );
});
