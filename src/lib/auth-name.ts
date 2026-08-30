const MIN_USER_NAME_LENGTH = 2;
const MAX_USER_NAME_LENGTH = 120;
const PROHIBITED_USER_NAME_PATTERN =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/**
 * Canonicalize the user-controlled display name before any signup lookup.
 * Returning null keeps transport-specific errors outside this shared policy.
 */
export function normalizePaperPilotUserName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (
    name.length < MIN_USER_NAME_LENGTH
    || name.length > MAX_USER_NAME_LENGTH
    || PROHIBITED_USER_NAME_PATTERN.test(name)
  ) return null;
  return name;
}
