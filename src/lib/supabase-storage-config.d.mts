export const PAPERPILOT_SUPABASE_PROJECT_REF: "avmcmmayvnjxrhrmgsdx";
export const PAPERPILOT_SUPABASE_URL: "https://avmcmmayvnjxrhrmgsdx.supabase.co";
export const PAPERPILOT_SUPABASE_PDF_BUCKET: "paperpilot-private-pdfs";
export const PAPERPILOT_SUPABASE_PDF_MAX_BYTES: 26214400;
export const PAPERPILOT_SUPABASE_PDF_MIME_TYPES: readonly ["application/pdf"];

export interface PaperPilotSupabaseStorageConfiguration {
  readonly projectRef: typeof PAPERPILOT_SUPABASE_PROJECT_REF;
  readonly url: typeof PAPERPILOT_SUPABASE_URL;
  readonly bucket: typeof PAPERPILOT_SUPABASE_PDF_BUCKET;
  readonly maxFileSizeBytes: typeof PAPERPILOT_SUPABASE_PDF_MAX_BYTES;
  readonly allowedMimeTypes: typeof PAPERPILOT_SUPABASE_PDF_MIME_TYPES;
  readonly secretKey?: string;
}

export function paperPilotSupabaseStorageConfiguration(
  environment?: Readonly<Record<string, string | undefined>>,
  options?: { requireSecret?: boolean },
): PaperPilotSupabaseStorageConfiguration;
