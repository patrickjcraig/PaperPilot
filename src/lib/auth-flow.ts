export const EMAIL_VERIFICATION_CALLBACK_PATH = "/sign-in?verified=1";
export const PASSWORD_RESET_CALLBACK_PATH = "/reset-password";
export const WORKSPACE_INVITATION_QUERY_PARAMETER = "invitation";
// Account erasure must be orchestrated by PaperPilot after retained authority,
// ownership, external storage, and connector credentials can be reconciled.
export const SELF_SERVICE_ACCOUNT_DELETION_ENABLED = false;

const RESET_TOKEN_PATTERN = /^[A-Za-z0-9]{24,128}$/;
const INVITATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;

export function normalizeWorkspaceInvitationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return INVITATION_ID_PATTERN.test(normalized) ? normalized : null;
}

export function emailVerificationCallbackPath(invitationId?: string | null): string {
  const normalized = normalizeWorkspaceInvitationId(invitationId);
  if (!normalized) return EMAIL_VERIFICATION_CALLBACK_PATH;
  return `${EMAIL_VERIFICATION_CALLBACK_PATH}&${new URLSearchParams({
    [WORKSPACE_INVITATION_QUERY_PARAMETER]: normalized,
  })}`;
}

export function isEmailVerificationCallbackPath(value: string): boolean {
  if (value === EMAIL_VERIFICATION_CALLBACK_PATH) return true;
  let parsed: URL;
  try {
    parsed = new URL(value, "https://paperpilot.invalid");
  } catch {
    return false;
  }
  if (
    parsed.origin !== "https://paperpilot.invalid"
    || parsed.pathname !== "/sign-in"
    || parsed.hash !== ""
    || parsed.searchParams.getAll("verified").length !== 1
    || parsed.searchParams.get("verified") !== "1"
    || parsed.searchParams.getAll(WORKSPACE_INVITATION_QUERY_PARAMETER).length !== 1
    || [...parsed.searchParams.keys()].some(
      (key) => key !== "verified" && key !== WORKSPACE_INVITATION_QUERY_PARAMETER,
    )
  ) return false;
  const invitationId = normalizeWorkspaceInvitationId(
    parsed.searchParams.get(WORKSPACE_INVITATION_QUERY_PARAMETER),
  );
  return invitationId !== null && emailVerificationCallbackPath(invitationId) === value;
}

export function invitationIdFromApplicationUrl(
  rawUrl: string,
  expectedOrigin: string,
): string | null {
  let current: URL;
  let origin: URL;
  try {
    current = new URL(rawUrl);
    origin = new URL(expectedOrigin);
  } catch {
    return null;
  }
  if (
    current.origin !== origin.origin
    || !["/sign-in", "/sign-up", "/app"].includes(current.pathname)
    || current.searchParams.getAll(WORKSPACE_INVITATION_QUERY_PARAMETER).length !== 1
  ) return null;
  return normalizeWorkspaceInvitationId(
    current.searchParams.get(WORKSPACE_INVITATION_QUERY_PARAMETER),
  );
}

export function invitationAwareAuthPath(
  path: "/sign-in" | "/sign-up",
  invitationId?: string | null,
): string {
  const normalized = normalizeWorkspaceInvitationId(invitationId);
  return normalized
    ? `${path}?${new URLSearchParams({ [WORKSPACE_INVITATION_QUERY_PARAMETER]: normalized })}`
    : path;
}

export function invitationAwareApplicationPath(invitationId?: string | null): string {
  const normalized = normalizeWorkspaceInvitationId(invitationId);
  return normalized
    ? `/app?${new URLSearchParams({ [WORKSPACE_INVITATION_QUERY_PARAMETER]: normalized })}#collaboration`
    : "/app";
}

export interface ResetLinkState {
  token: string | null;
  cleanPath: string;
}

export function shouldDisableProductionSignUp(
  productionVerificationRequired: boolean,
  emailDeliveryConfigured: boolean,
): boolean {
  return productionVerificationRequired && !emailDeliveryConfigured;
}

/**
 * Read a Better Auth reset token without retaining it in browser history.
 *
 * New PaperPilot reset messages use a fragment, which browsers do not send to
 * the server or in a Referer header. The query-string form remains accepted so
 * links issued by Better Auth before this hardening change continue to work.
 */
export function resetLinkStateFromUrl(rawUrl: string, expectedOrigin: string): ResetLinkState {
  let current: URL;
  let origin: URL;
  try {
    current = new URL(rawUrl);
    origin = new URL(expectedOrigin);
  } catch {
    return { token: null, cleanPath: PASSWORD_RESET_CALLBACK_PATH };
  }

  if (
    current.origin !== origin.origin
    || current.pathname !== PASSWORD_RESET_CALLBACK_PATH
  ) {
    return { token: null, cleanPath: PASSWORD_RESET_CALLBACK_PATH };
  }

  const fragment = new URLSearchParams(current.hash.startsWith("#")
    ? current.hash.slice(1)
    : current.hash);
  const fragmentTokens = fragment.getAll("token");
  const queryTokens = current.searchParams.getAll("token");
  const hasProviderError = current.searchParams.has("error");
  const allTokens = [...fragmentTokens, ...queryTokens];
  const token = !hasProviderError && allTokens.length === 1 && RESET_TOKEN_PATTERN.test(allTokens[0])
    ? allTokens[0]
    : null;

  return { token, cleanPath: PASSWORD_RESET_CALLBACK_PATH };
}
