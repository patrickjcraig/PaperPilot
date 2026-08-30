import { TextDecoder } from "node:util";

import { RunnerFailure } from "./errors.js";
import type { ExtractedTextChunk } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const FORMAT_OR_DISALLOWED_CONTROL = /[\p{Cc}\p{Cf}]/u;
const HORIZONTAL_SPACE = /[\p{Zs}\t]+/gu;

export interface TextLimits {
  maxTextBytes: number;
  maxChunkCount: number;
  maxChunkBytes: number;
}

export interface NormalizedText {
  chunks: ExtractedTextChunk[];
  textBytes: number;
}

function rejectUnsafeUnicode(value: string): void {
  // Page/line delimiters are the only permitted controls. Every Unicode
  // format control (including bidi and zero-width controls) is rejected rather
  // than silently changing what a reader sees.
  const withoutDelimiters = value.replace(/[\t\n\r\f]/g, "");
  if (FORMAT_OR_DISALLOWED_CONTROL.test(withoutDelimiters)) {
    throw new RunnerFailure("protocol");
  }
  for (const character of value) {
    const point = character.codePointAt(0);
    if (
      point === undefined
      || (point >= 0xfdd0 && point <= 0xfdef)
      || (point & 0xffff) === 0xfffe
      || (point & 0xffff) === 0xffff
    ) {
      throw new RunnerFailure("protocol");
    }
  }
}

function paragraphsForPage(rawPage: string): string[] {
  const normalized = rawPage
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .normalize("NFC");
  rejectUnsafeUnicode(normalized);

  const paragraphs: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length === 0) return;
    const paragraph = lines.join(" ").replace(HORIZONTAL_SPACE, " ").trim();
    lines = [];
    if (paragraph.length > 0) paragraphs.push(paragraph);
  };
  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.replace(HORIZONTAL_SPACE, " ").trim();
    if (line.length === 0) flush();
    else lines.push(line);
  }
  flush();
  return paragraphs;
}

function prefixWithinUtf8Limit(value: string, maximumBytes: number): number {
  let bytes = 0;
  let end = 0;
  let lastSpace = -1;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    if (character === " ") lastSpace = end;
    bytes += characterBytes;
    end += character.length;
  }
  if (end === value.length) return end;
  if (value[end] === " ") return end;
  if (lastSpace > 0) return lastSpace;
  if (end < 1) throw new RunnerFailure("output_limit");
  return end;
}

function splitParagraph(value: string, maximumBytes: number): string[] {
  const parts: string[] = [];
  let remaining = value;
  while (Buffer.byteLength(remaining, "utf8") > maximumBytes) {
    const end = prefixWithinUtf8Limit(remaining, maximumBytes);
    const part = remaining.slice(0, end).trimEnd();
    if (part.length === 0) throw new RunnerFailure("protocol");
    parts.push(part);
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

export function normalizePopplerText(
  bytes: Buffer,
  pageCount: number,
  limits: TextLimits,
): NormalizedText {
  let raw: string;
  try { raw = decoder.decode(bytes); } catch { throw new RunnerFailure("protocol"); }
  rejectUnsafeUnicode(raw);

  const pages = raw.split("\f");
  const terminalPage = pages.at(-1);
  if (
    pages.length === pageCount + 1
    && terminalPage !== undefined
    && /^[ \t\r\n]*$/.test(terminalPage)
  ) {
    pages.pop();
  }
  if (pages.length !== pageCount) throw new RunnerFailure("protocol");

  const chunks: ExtractedTextChunk[] = [];
  let textBytes = 0;
  let normalizedSourceBytes = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const pageNumber = pageIndex + 1;
    const page = pages[pageIndex];
    if (page === undefined) throw new RunnerFailure("protocol");
    const paragraphs = paragraphsForPage(page);
    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
      const paragraph = paragraphs[paragraphIndex];
      if (paragraph === undefined) throw new RunnerFailure("protocol");
      normalizedSourceBytes += Buffer.byteLength(paragraph, "utf8");
      if (normalizedSourceBytes > limits.maxTextBytes) {
        throw new RunnerFailure("output_limit");
      }
      const paragraphId = `p${pageNumber}-p${paragraphIndex + 1}`;
      for (const text of splitParagraph(paragraph, limits.maxChunkBytes)) {
        if (chunks.length >= limits.maxChunkCount) throw new RunnerFailure("output_limit");
        const bytesInChunk = Buffer.byteLength(text, "utf8");
        textBytes += bytesInChunk;
        if (bytesInChunk < 1 || textBytes > limits.maxTextBytes) {
          throw new RunnerFailure("output_limit");
        }
        chunks.push({
          sequence: chunks.length,
          pageNumber,
          paragraphId,
          text,
        });
      }
    }
  }
  return { chunks, textBytes };
}
