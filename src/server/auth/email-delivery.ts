import "server-only";

import {
  isEmailVerificationCallbackPath,
  PASSWORD_RESET_CALLBACK_PATH,
} from "@/lib/auth-flow";

const DELIVERY_TIMEOUT_MS = 10_000;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9]{24,128}$/;
const VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,4096}$/;

export type AuthEmailKind = "email-verification" | "password-reset";

export interface TransactionalEmail {
  kind: AuthEmailKind;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface TransactionalEmailDelivery {
  deliver(message: TransactionalEmail): Promise<void>;
}

export interface AuthEmailDelivery {
  sendVerification(input: AuthEmailInput): Promise<void>;
  sendPasswordReset(input: AuthEmailInput): Promise<void>;
}

export interface AuthEmailInput {
  email: string;
  name: string;
  url: string;
  token: string;
}

export interface WebhookEmailConfiguration {
  endpoint: URL;
  bearerToken: string;
  from: string;
}

interface WebhookDeliveryOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type EmailEnvironment = Record<string, string | undefined>;

class InvalidAuthEmailLinkError extends Error {
  constructor() {
    super("Refusing to deliver an invalid authentication link.");
    this.name = "InvalidAuthEmailLinkError";
  }
}

class TransactionalEmailDeliveryError extends Error {
  constructor() {
    super("Transactional email delivery failed.");
    this.name = "TransactionalEmailDeliveryError";
  }
}

function requiredConfigurationValue(
  values: Record<string, string | undefined>,
  name: string,
): string {
  const value = values[name];
  if (!value) {
    throw new Error(
      "PAPERPILOT_EMAIL_WEBHOOK_URL, PAPERPILOT_EMAIL_WEBHOOK_SECRET, and "
      + "PAPERPILOT_EMAIL_FROM must be configured together.",
    );
  }
  return value;
}

/** Parse the all-or-nothing, server-only webhook delivery configuration. */
export function webhookEmailConfigurationFromEnvironment(
  environment: EmailEnvironment = process.env,
): WebhookEmailConfiguration | null {
  const values = {
    PAPERPILOT_EMAIL_WEBHOOK_URL: environment.PAPERPILOT_EMAIL_WEBHOOK_URL?.trim() || undefined,
    PAPERPILOT_EMAIL_WEBHOOK_SECRET:
      environment.PAPERPILOT_EMAIL_WEBHOOK_SECRET?.trim() || undefined,
    PAPERPILOT_EMAIL_FROM: environment.PAPERPILOT_EMAIL_FROM?.trim() || undefined,
  };

  if (Object.values(values).every((value) => value === undefined)) return null;

  const rawEndpoint = requiredConfigurationValue(values, "PAPERPILOT_EMAIL_WEBHOOK_URL");
  const bearerToken = requiredConfigurationValue(values, "PAPERPILOT_EMAIL_WEBHOOK_SECRET");
  const from = requiredConfigurationValue(values, "PAPERPILOT_EMAIL_FROM");

  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error("PAPERPILOT_EMAIL_WEBHOOK_URL must be an absolute HTTPS URL.");
  }
  if (
    endpoint.protocol !== "https:"
    || endpoint.username !== ""
    || endpoint.password !== ""
    || endpoint.search !== ""
    || endpoint.hash !== ""
  ) {
    throw new Error(
      "PAPERPILOT_EMAIL_WEBHOOK_URL must be HTTPS and cannot contain credentials, a query, or a fragment.",
    );
  }
  if (
    bearerToken.length < 32
    || new Set(bearerToken).size < 12
    || /(?:change[-_ ]?me|development[-_ ]?only|example[-_ ]?secret)/i.test(bearerToken)
  ) {
    throw new Error(
      "PAPERPILOT_EMAIL_WEBHOOK_SECRET must be an independent high-entropy secret "
      + "containing at least 32 characters.",
    );
  }
  if (from.length > 254 || !EMAIL_PATTERN.test(from)) {
    throw new Error("PAPERPILOT_EMAIL_FROM must be a valid email address.");
  }

  return { endpoint, bearerToken, from };
}

function validRecipient(value: string): boolean {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

function sanitizedName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hasExactlyOneParameter(url: URL, name: string, expected: string): boolean {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] === expected;
}

function hasOnlyExpectedParameters(url: URL, expectedNames: string[]): boolean {
  return [...url.searchParams.keys()].every((name) => expectedNames.includes(name));
}

function validateBetterAuthActionUrl(
  rawUrl: string,
  token: string,
  kind: AuthEmailKind,
  applicationOrigin: string,
): URL {
  let actionUrl: URL;
  try {
    actionUrl = new URL(rawUrl);
  } catch {
    throw new InvalidAuthEmailLinkError();
  }

  if (
    actionUrl.origin !== applicationOrigin
    || actionUrl.username !== ""
    || actionUrl.password !== ""
    || actionUrl.hash !== ""
  ) {
    throw new InvalidAuthEmailLinkError();
  }

  if (kind === "email-verification") {
    const callbackValues = actionUrl.searchParams.getAll("callbackURL");
    if (
      actionUrl.pathname !== "/api/auth/verify-email"
      || !VERIFICATION_TOKEN_PATTERN.test(token)
      || !hasOnlyExpectedParameters(actionUrl, ["token", "callbackURL"])
      || !hasExactlyOneParameter(actionUrl, "token", token)
      || callbackValues.length !== 1
      || !isEmailVerificationCallbackPath(callbackValues[0])
    ) {
      throw new InvalidAuthEmailLinkError();
    }
  } else {
    const encodedToken = actionUrl.pathname.slice("/api/auth/reset-password/".length);
    let decodedToken: string;
    try {
      decodedToken = decodeURIComponent(encodedToken);
    } catch {
      throw new InvalidAuthEmailLinkError();
    }
    if (
      !actionUrl.pathname.startsWith("/api/auth/reset-password/")
      || encodedToken.includes("/")
      || !RESET_TOKEN_PATTERN.test(token)
      || decodedToken !== token
      || !hasOnlyExpectedParameters(actionUrl, ["callbackURL"])
      || !hasExactlyOneParameter(actionUrl, "callbackURL", PASSWORD_RESET_CALLBACK_PATH)
    ) {
      throw new InvalidAuthEmailLinkError();
    }
  }

  return actionUrl;
}

export function createWebhookTransactionalEmailDelivery(
  configuration: WebhookEmailConfiguration,
  options: WebhookDeliveryOptions = {},
): TransactionalEmailDelivery {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;

  return {
    async deliver(message) {
      if (!validRecipient(message.to)) throw new TransactionalEmailDeliveryError();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(configuration.endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${configuration.bearerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            schemaVersion: 1,
            message: {
              ...message,
              from: configuration.from,
            },
          }),
          redirect: "error",
          signal: controller.signal,
        });
        if (!response.ok) throw new TransactionalEmailDeliveryError();
      } catch {
        // Provider bodies, endpoint details, action URLs, and tokens are never
        // copied into an application error or Better Auth log entry.
        throw new TransactionalEmailDeliveryError();
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createAuthEmailDelivery(
  applicationOrigin: string,
  delivery: TransactionalEmailDelivery,
): AuthEmailDelivery {
  const parsedOrigin = new URL(applicationOrigin);
  if (parsedOrigin.origin !== applicationOrigin) {
    throw new Error("The authentication application origin must not contain a path.");
  }

  async function send(input: AuthEmailInput, kind: AuthEmailKind): Promise<void> {
    validateBetterAuthActionUrl(input.url, input.token, kind, applicationOrigin);
    if (!validRecipient(input.email)) throw new TransactionalEmailDeliveryError();

    const name = sanitizedName(input.name);
    const greeting = name ? `Hello ${name},` : "Hello,";
    const actionUrl = kind === "password-reset"
      ? `${applicationOrigin}${PASSWORD_RESET_CALLBACK_PATH}#${new URLSearchParams({ token: input.token })}`
      : input.url;
    const verification = kind === "email-verification";
    const subject = verification
      ? "Verify your PaperPilot email"
      : "Reset your PaperPilot password";
    const instruction = verification
      ? "Verify your email to activate your PaperPilot workspace."
      : "Use this one-time link to choose a new PaperPilot password.";
    const expiry = verification
      ? "This link expires in 24 hours."
      : "This link expires in 1 hour.";
    const ignored = "If you did not request this, you can ignore this message.";

    try {
      await delivery.deliver({
        kind,
        to: input.email,
        subject,
        text: `${greeting}\n\n${instruction}\n\n${actionUrl}\n\n${expiry} ${ignored}`,
        html: [
          `<p>${escapeHtml(greeting)}</p>`,
          `<p>${escapeHtml(instruction)}</p>`,
          `<p><a href="${escapeHtml(actionUrl)}">${verification ? "Verify email" : "Reset password"}</a></p>`,
          `<p>${escapeHtml(expiry)} ${escapeHtml(ignored)}</p>`,
        ].join(""),
      });
    } catch {
      // All transport implementations share the same redaction boundary.
      throw new TransactionalEmailDeliveryError();
    }
  }

  return {
    sendVerification: (input) => send(input, "email-verification"),
    sendPasswordReset: (input) => send(input, "password-reset"),
  };
}

export function createAuthEmailDeliveryFromEnvironment(
  applicationOrigin: string,
  environment: EmailEnvironment = process.env,
): AuthEmailDelivery | null {
  const configuration = webhookEmailConfigurationFromEnvironment(environment);
  if (!configuration) return null;
  return createAuthEmailDelivery(
    applicationOrigin,
    createWebhookTransactionalEmailDelivery(configuration),
  );
}
