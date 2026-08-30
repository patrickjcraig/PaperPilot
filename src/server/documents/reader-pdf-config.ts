import "server-only";

import { HttpProblem } from "@/server/http/problem";

export const READER_PDFJS_FLAG = "PAPERPILOT_READER_PDFJS";

export function readerPdfJsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment[READER_PDFJS_FLAG] ?? "0";
  if (value !== "0" && value !== "1") {
    throw new Error(`${READER_PDFJS_FLAG} must be exactly 0 or 1.`);
  }
  return value === "1";
}

export function requireReaderPdfJsEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (!readerPdfJsEnabled(environment)) {
    throw new HttpProblem(
      404,
      "reader_pdf_unavailable",
      "Visual PDF page rendering is unavailable.",
    );
  }
}
