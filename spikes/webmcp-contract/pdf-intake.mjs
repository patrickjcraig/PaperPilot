const INTAKE_MESSAGES = Object.freeze({
  demo_http_failed: "The paper host did not return the demo PDF. Try again or choose a local PDF.",
  demo_not_pdf: "The paper host returned something other than a PDF. Choose a local PDF instead.",
  demo_size_limit: "The demo response exceeds the PDF size limit. Choose a local PDF within the published limit.",
  demo_empty: "The paper host returned an empty file. Try again or choose a local PDF.",
  demo_stream_unavailable: "This browser could not read the demo safely. Choose a local PDF instead.",
  demo_fetch_failed: "The demo could not be downloaded. Check your connection or choose a local PDF.",
  demo_integrity_mismatch: "The downloaded demo does not match the recorded Attention v7 PDF. Nothing was opened. Choose a local PDF instead.",
  intake_cancelled: "Opening the demo was cancelled or timed out. Try again or choose a local PDF.",
});

/** @typedef {keyof typeof INTAKE_MESSAGES} IntakeErrorCode */

export class PdfIntakeError extends Error {
  /** @param {IntakeErrorCode} code */
  constructor(code) {
    super(INTAKE_MESSAGES[code]);
    this.name = "PdfIntakeError";
    this.code = code;
  }
}

/** Do not expose network/parser messages, URLs, or exception names in the UI.
 * @param {unknown} error
 * @returns {{code: IntakeErrorCode, message: string}}
 */
export function safeDemoFailure(error) {
  const code = error instanceof PdfIntakeError && Object.hasOwn(INTAKE_MESSAGES, error.code)
    ? error.code : "demo_fetch_failed";
  return { code, message: INTAKE_MESSAGES[code] };
}

/** Read only an explicitly requested PDF, stopping before an unbounded blob allocation.
 * The caller owns the URL, release limit, timeout, and exact-demo fingerprint check.
 * @param {Response} response
 * @param {{maxBytes: number, signal?: AbortSignal}} options
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export async function readBoundedPdfResponse(response, { maxBytes, signal }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new PdfIntakeError("demo_size_limit");
  /** @type {ReadableStreamDefaultReader<Uint8Array> | undefined} */
  let reader;
  /** @type {((reason: PdfIntakeError) => void) | undefined} */
  let rejectAbort;
  let finished = false;
  let cancellationRequested = false;
  const cancel = () => {
    if (finished || cancellationRequested) return;
    cancellationRequested = true;
    try {
      const cancellation = reader ? reader.cancel() : response.body?.cancel();
      void cancellation?.catch(() => {});
    } catch { /* Cleanup cannot replace the safe terminal failure. */ }
  };
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  // The signal can already be aborted before the first read is raced.
  void aborted.catch(() => {});
  const onAbort = () => { cancel(); rejectAbort?.(new PdfIntakeError("intake_cancelled")); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw new PdfIntakeError("intake_cancelled");
    if (!response.ok) throw new PdfIntakeError("demo_http_failed");
    const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (mime !== "application/pdf") throw new PdfIntakeError("demo_not_pdf");
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d{1,16}$/u.test(length) || Number(length) > maxBytes)) {
      throw new PdfIntakeError("demo_size_limit");
    }
    if (!response.body?.getReader) throw new PdfIntakeError("demo_stream_unavailable");
    reader = response.body.getReader();
    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    while (true) {
      const result = await Promise.race([reader.read(), aborted]);
      if (signal?.aborted) throw new PdfIntakeError("intake_cancelled");
      const { done, value } = /** @type {ReadableStreamReadResult<Uint8Array>} */ (result);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new PdfIntakeError("demo_stream_unavailable");
      total += value.byteLength;
      if (total > maxBytes) throw new PdfIntakeError("demo_size_limit");
      if (value.byteLength) chunks.push(value);
    }
    if (total === 0) throw new PdfIntakeError("demo_empty");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    finished = true;
    return bytes;
  } catch (error) {
    cancel();
    if (signal?.aborted) throw new PdfIntakeError("intake_cancelled");
    if (error instanceof PdfIntakeError) throw error;
    throw new PdfIntakeError("demo_fetch_failed");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { reader?.releaseLock(); } catch { /* An aborted read may still be settling. */ }
  }
}
