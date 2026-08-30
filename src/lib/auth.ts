import "server-only";

import { prismaAdapter } from "@better-auth/prisma-adapter";
import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";
import {
  SELF_SERVICE_ACCOUNT_DELETION_ENABLED,
  shouldDisableProductionSignUp,
} from "@/lib/auth-flow";
import { normalizePaperPilotUserName } from "@/lib/auth-name";
import { prisma } from "@/lib/prisma";
import {
  DISABLED_GENERIC_ORGANIZATION_PATHS,
  paperPilotOrganizationRoles,
} from "@/lib/workspace-roles";
import { createAuthEmailDeliveryFromEnvironment } from "@/server/auth/email-delivery";
import {
  betterAuthRateLimitConfig,
  paperPilotIpAddressConfig,
} from "@/server/rate-limit/auth-config";

function explicitLocalEvaluationConfigured(): boolean {
  if (process.env.PAPERPILOT_ALLOW_INSECURE_ORIGIN !== "true") return false;
  const configured = process.env.BETTER_AUTH_URL?.trim();
  if (!configured) return false;
  try {
    const hostname = new URL(configured).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost";
  } catch {
    return false;
  }
}

function authSecret(): string {
  const value = process.env.BETTER_AUTH_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  }
  if (
    process.env.NODE_ENV === "production"
    && !explicitLocalEvaluationConfigured()
    && (
      value === "replace-with-at-least-32-random-characters"
      || /(?:change[-_ ]?me|development[-_ ]?only|example[-_ ]?secret)/i.test(value)
      || new Set(value).size < 12
    )
  ) {
    throw new Error("BETTER_AUTH_SECRET must be an independent high-entropy production secret.");
  }
  return value;
}

function authBaseUrl(): string {
  const configured = process.env.BETTER_AUTH_URL?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("BETTER_AUTH_URL is required in production.");
    }
    return "http://127.0.0.1:3000";
  }

  const parsed = new URL(configured);
  const explicitlyAllowedLocalOrigin =
    process.env.PAPERPILOT_ALLOW_INSECURE_ORIGIN === "true"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (
    process.env.NODE_ENV === "production"
    && parsed.protocol !== "https:"
    && !explicitlyAllowedLocalOrigin
  ) {
    throw new Error("BETTER_AUTH_URL must use HTTPS in production.");
  }
  return parsed.origin;
}

const baseURL = authBaseUrl();
const isExplicitLocalEvaluation = explicitLocalEvaluationConfigured();
export const productionIdentityVerificationRequired =
  process.env.NODE_ENV === "production" && !isExplicitLocalEvaluation;
const authEmailDelivery = createAuthEmailDeliveryFromEnvironment(baseURL);
export const productionIdentityEmailDeliveryConfigured = authEmailDelivery !== null;
const productionSignUpDisabled = shouldDisableProductionSignUp(
  productionIdentityVerificationRequired,
  productionIdentityEmailDeliveryConfigured,
);
const developmentOrigins = ["http://127.0.0.1:3000", "http://localhost:3000"];

function invalidName(): never {
  throw APIError.fromStatus("BAD_REQUEST", {
    code: "INVALID_NAME",
    message: "Name must contain 2 to 120 characters.",
  });
}

export const auth = betterAuth({
  appName: "PaperPilot",
  baseURL,
  secret: authSecret(),
  disabledPaths: [...DISABLED_GENERIC_ORGANIZATION_PATHS],
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  rateLimit: betterAuthRateLimitConfig,
  hooks: {
    before: createAuthMiddleware(async (context) => {
      if (context.path !== "/sign-up/email") return;
      const name = normalizePaperPilotUserName(context.body.name);
      if (!name) invalidName();
      // This hook runs before Better Auth's existing-email branch, so malformed
      // names cannot distinguish an existing account from a new one.
      context.body.name = name;
    }),
  },
  emailAndPassword: {
    enabled: true,
    // Missing delivery configuration keeps production registration closed.
    // Local evaluation retains the existing account flow without email.
    disableSignUp: productionSignUpDisabled,
    requireEmailVerification: productionIdentityVerificationRequired,
    autoSignIn: !productionIdentityVerificationRequired,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    ...(authEmailDelivery
      ? {
          sendResetPassword: async ({ user, url, token }) => {
            await authEmailDelivery.sendPasswordReset({
              email: user.email,
              name: user.name,
              url,
              token,
            });
          },
        }
      : {}),
  },
  ...(authEmailDelivery
    ? {
        emailVerification: {
          expiresIn: 60 * 60 * 24,
          sendOnSignUp: productionIdentityVerificationRequired,
          sendOnSignIn: productionIdentityVerificationRequired,
          autoSignInAfterVerification: false,
          sendVerificationEmail: async ({ user, url, token }) => {
            await authEmailDelivery.sendVerification({
              email: user.email,
              name: user.name,
              url,
              token,
            });
          },
        },
      }
    : {}),
  user: {
    deleteUser: {
      enabled: SELF_SERVICE_ACCOUNT_DELETION_ENABLED,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const name = normalizePaperPilotUserName(user.name);
          if (!name) invalidName();
          return { data: { ...user, name } };
        },
      },
      update: {
        before: async (user) => {
          if (user.name === undefined) return;
          const name = normalizePaperPilotUserName(user.name);
          if (!name) invalidName();
          return { data: { ...user, name } };
        },
      },
    },
  },
  advanced: {
    ipAddress: paperPilotIpAddressConfig,
    database: {
      joins: true,
    },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: false,
      roles: paperPilotOrganizationRoles,
      requireEmailVerificationOnInvitation: process.env.NODE_ENV === "production",
      // Better Auth cannot erase PaperPilot's restricted provenance, audit,
      // document, credential, and storage graph. Keep its generic endpoint
      // closed until the application-owned two-phase tenant erasure service is
      // available.
      disableOrganizationDeletion: true,
    }),
  ],
  trustedOrigins:
    process.env.NODE_ENV === "production"
      ? [baseURL]
      : Array.from(new Set([baseURL, ...developmentOrigins])),
});

export type PaperPilotSession = typeof auth.$Infer.Session;
