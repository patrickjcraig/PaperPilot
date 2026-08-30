import "server-only";

import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  credentialProtectorFromEnvironment,
  type CredentialProtector,
} from "@/server/integrations/credential-protection";
import {
  ZoteroReadOnlyAdapter,
  type ZoteroReadOnlyAdapterOptions,
} from "./adapter";
import type { ZoteroCredentialResolver } from "./contracts";

export interface ZoteroClientFactoryDependencies {
  database?: PrismaClient;
  credentialProtector?: CredentialProtector;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/**
 * Resolve a key only for the already-authorized tenant/connection tuple.
 * A foreign ID, disconnected row, wrong provider, or incomplete envelope is
 * deliberately indistinguishable and causes no provider request.
 */
export function createZoteroCredentialResolver(
  dependencies: {
    database?: PrismaClient;
    credentialProtector?: CredentialProtector;
  } = {},
): ZoteroCredentialResolver {
  const database = dependencies.database ?? prisma;
  const protector = dependencies.credentialProtector
    ?? credentialProtectorFromEnvironment();
  return async ({ organizationId, connectionId }) => {
    const connection = await database.integrationConnection.findUnique({
      where: {
        organizationId_id: {
          organizationId,
          id: connectionId,
        },
      },
      select: {
        provider: true,
        status: true,
        credentialCiphertext: true,
        credentialKeyVersion: true,
      },
    });
    if (
      !connection
      || connection.provider !== "ZOTERO"
      || (
        connection.status !== "CONNECTED"
        && connection.status !== "DEGRADED"
      )
      || !connection.credentialCiphertext
      || !connection.credentialKeyVersion
    ) return null;
    return {
      accessToken: protector.reveal(
        connection.credentialCiphertext,
        connection.credentialKeyVersion,
        {
          organizationId,
          provider: "ZOTERO",
          subjectId: connectionId,
        },
      ),
    };
  };
}

export function createZoteroReadOnlyClient(
  dependencies: ZoteroClientFactoryDependencies = {},
): ZoteroReadOnlyAdapter {
  const options: ZoteroReadOnlyAdapterOptions = {
    credentialResolver: createZoteroCredentialResolver(dependencies),
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
    timeoutMs: dependencies.timeoutMs,
    maxResponseBytes: dependencies.maxResponseBytes,
  };
  return new ZoteroReadOnlyAdapter(options);
}
