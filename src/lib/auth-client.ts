"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-only Better Auth client. It deliberately relies on the current
 * origin so preview, local, and production deployments use the same bundle.
 */
export const authClient = createAuthClient();
