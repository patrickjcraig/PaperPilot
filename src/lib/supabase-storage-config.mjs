export const PAPERPILOT_SUPABASE_PROJECT_REF = "avmcmmayvnjxrhrmgsdx";
export const PAPERPILOT_SUPABASE_URL =
  `https://${PAPERPILOT_SUPABASE_PROJECT_REF}.supabase.co`;
export const PAPERPILOT_SUPABASE_PDF_BUCKET = "paperpilot-private-pdfs";
export const PAPERPILOT_SUPABASE_PDF_MAX_BYTES = 25 * 1024 * 1024;
export const PAPERPILOT_SUPABASE_PDF_MIME_TYPES = Object.freeze([
  "application/pdf",
]);

const SECRET_KEY_PATTERN = /^sb_secret_[A-Za-z0-9._-]{20,}$/u;

function exactEnvironmentValue(environment, name, expected) {
  const value = environment[name];
  if (value !== expected) {
    throw new Error(`${name} must equal the approved PaperPilot Supabase value.`);
  }
  return value;
}

/** Parse the one private Storage authority without contacting Supabase. */
export function paperPilotSupabaseStorageConfiguration(
  environment = process.env,
  options = {},
) {
  for (const forbidden of [
    "NEXT_PUBLIC_PAPERPILOT_SUPABASE_SECRET_KEY",
    "NEXT_PUBLIC_SUPABASE_SECRET_KEY",
    "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
    "PAPERPILOT_SUPABASE_SERVICE_ROLE_KEY",
  ]) {
    if (environment[forbidden]?.trim()) {
      throw new Error(`${forbidden} is forbidden; use one server-only Supabase secret key.`);
    }
  }

  const projectRef = exactEnvironmentValue(
    environment,
    "PAPERPILOT_SUPABASE_PROJECT_REF",
    PAPERPILOT_SUPABASE_PROJECT_REF,
  );
  const url = exactEnvironmentValue(
    environment,
    "PAPERPILOT_SUPABASE_URL",
    PAPERPILOT_SUPABASE_URL,
  );
  const bucket = exactEnvironmentValue(
    environment,
    "PAPERPILOT_SUPABASE_STORAGE_BUCKET",
    PAPERPILOT_SUPABASE_PDF_BUCKET,
  );
  const parsedUrl = new URL(url);
  if (
    parsedUrl.origin !== url
    || (parsedUrl.pathname !== "" && parsedUrl.pathname !== "/")
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.search
    || parsedUrl.hash
  ) {
    throw new Error("PAPERPILOT_SUPABASE_URL must be the exact HTTPS project origin.");
  }

  const secretKey = environment.PAPERPILOT_SUPABASE_SECRET_KEY?.trim() ?? "";
  if (options.requireSecret === true && !SECRET_KEY_PATTERN.test(secretKey)) {
    throw new Error(
      "PAPERPILOT_SUPABASE_SECRET_KEY must contain one server-only sb_secret_ key.",
    );
  }
  if (secretKey && !SECRET_KEY_PATTERN.test(secretKey)) {
    throw new Error("PAPERPILOT_SUPABASE_SECRET_KEY has an invalid shape.");
  }

  return Object.freeze({
    projectRef,
    url,
    bucket,
    maxFileSizeBytes: PAPERPILOT_SUPABASE_PDF_MAX_BYTES,
    allowedMimeTypes: PAPERPILOT_SUPABASE_PDF_MIME_TYPES,
    ...(secretKey ? { secretKey } : {}),
  });
}
