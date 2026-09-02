/**
 * Deterministic, paper-agnostic PDF text analysis for the disposable WebMCP spike.
 *
 * This module does not assert that it has understood a paper. It turns ordered,
 * page-owned PDF text into reviewable critical-idea candidates and a
 * presentation-only layout plan. The application must mint trusted page/text
 * anchors before promoting any candidate into the canonical semantic graph.
 */

export const PAPER_ANALYSIS_VERSION = 1;
export const PAPER_ANALYSIS_LIMITS = Object.freeze({ pages: 200, linesPerPage: 20_000, charactersPerPage: 200_000, documentCharacters: 2_000_000 });

export const SYSTEM_CANDIDATE_AUTHORITY = "system_derived_candidate";

export const PAPER_ANALYSIS_CLAIM_BOUNDARY =
  "Ranked from extracted PDF text by generic heuristics. These are reviewable candidates, not verified scientific claims.";

export const DEFAULT_PAPER_ANALYSIS_OPTIONS = Object.freeze({
  minCandidates: 5,
  maxCandidates: 12,
  maxCandidatesPerPage: 2,
  scoreThreshold: 0.16,
});

export const CRITICAL_IDEA_NODE_KINDS = Object.freeze([
  "main_idea",
  "method",
  "result",
  "concept",
  "term",
  "figure",
  "equation",
]);

const KIND_LANES = Object.freeze({
  main_idea: 0,
  method: -1.15,
  result: 1.15,
  concept: 0,
  term: -1.8,
  figure: 1.8,
  equation: -2.35,
});

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "can",
  "could", "did", "do", "does", "doing", "during", "each", "few", "for", "from", "further", "had", "has",
  "have", "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "i", "if", "in",
  "into", "is", "it", "its", "itself", "just", "may", "me", "might", "more", "most", "my", "myself", "no",
  "nor", "not", "of", "off", "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over",
  "own", "same", "she", "should", "so", "some", "such", "than", "that", "the", "their", "theirs", "them",
  "themselves", "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until",
  "up", "very", "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will",
  "with", "would", "you", "your", "yours", "yourself", "yourselves", "using", "used", "use", "based", "paper",
  "study", "section", "figure", "table", "et", "al",
]);

const HEADING_SECTION_WEIGHTS = Object.freeze([
  [/(?:^|\b)abstract(?:\b|$)/iu, 0.19, "abstract_section"],
  [/(?:^|\b)(?:conclusion|conclusions|summary)(?:\b|$)/iu, 0.18, "conclusion_section"],
  [/(?:^|\b)(?:result|results|findings)(?:\b|$)/iu, 0.15, "results_section"],
  [/(?:^|\b)(?:method|methods|methodology|materials and methods|approach)(?:\b|$)/iu, 0.13, "methods_section"],
  [/(?:^|\b)(?:discussion|analysis)(?:\b|$)/iu, 0.1, "discussion_section"],
  [/(?:^|\b)(?:introduction|background)(?:\b|$)/iu, 0.08, "introduction_section"],
]);

const REFERENCE_HEADINGS = new Set([
  "references",
  "bibliography",
  "works cited",
  "literature cited",
  "reference list",
]);

const GENERIC_SECTION_HEADINGS = new Set([
  "abstract",
  "background",
  "conclusion",
  "conclusions",
  "discussion",
  "evaluation",
  "experiment",
  "experiments",
  "findings",
  "introduction",
  "limitations",
  "method",
  "methodology",
  "methods",
  "result",
  "results",
  "summary",
]);

const CLAIM_CUES = Object.freeze([
  /\bwe (?:propose|introduce|present|develop|demonstrate|show|find|observe|report|establish)\b/iu,
  /\b(?:our|this) (?:approach|method|model|framework|analysis|study|results?)\b/iu,
  /\b(?:the results?|these findings|our findings) (?:show|suggest|indicate|demonstrate|reveal)\b/iu,
  /\b(?:significantly|substantially|consistently) (?:improves?|reduces?|increases?|outperforms?)\b/iu,
]);

const METHOD_CUES = Object.freeze([
  /\b(?:we|the authors?) (?:propose|introduce|present|develop|design|construct|train|estimate)\b/iu,
  /\b(?:method|methodology|algorithm|architecture|procedure|protocol|framework|pipeline|model)\b/iu,
]);

const RESULT_CUES = Object.freeze([
  /\b(?:we|the authors?) (?:show|find|found|observe|report|demonstrate|achieve)\b/iu,
  /\b(?:results?|findings?|experiments?|evaluation) (?:show|shows|showed|suggest|suggests|indicate|indicates|demonstrate|demonstrates|reveal|reveals)\b/iu,
  /\b(?:outperform|improve|increase|decrease|reduce|correlat|significant|accuracy|performance|effect)\w*\b/iu,
]);

const DEFINITION_CUES = Object.freeze([
  /\b(?:is|are) defined as\b/iu,
  /\brefers? to\b/iu,
  /\bwe (?:call|define|denote)\b/iu,
  /\bmeans?\b/iu,
]);

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function rounded(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function stableToken(value) {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

export function normalizePaperText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/gu, "")
    .replace(/[‐‑‒–—]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();
}

function lineText(line) {
  if (typeof line === "string") return normalizePaperText(line);
  if (!line || typeof line !== "object") return "";
  return normalizePaperText(line.text ?? line.str ?? line.value ?? "");
}

function rawLinesForPage(page) {
  if (Array.isArray(page.lines) && page.lines.length) {
    return page.lines
      .map((line, orderIndex) => ({
        text: lineText(line),
        lineIndex: Number.isSafeInteger(line?.lineIndex) && line.lineIndex >= 0 ? line.lineIndex : orderIndex,
        lineId: typeof line?.lineId === "string" && line.lineId ? line.lineId.slice(0, 160) : null,
        fontSize: Number.isFinite(line?.fontSize) ? line.fontSize : null,
        fontHeight: Number.isFinite(line?.fontHeight) ? line.fontHeight : Number.isFinite(line?.height) ? line.height : null,
        explicitHeading: Boolean(line?.isHeading),
      }))
      .filter((line) => line.text);
  }
  return String(page.text ?? "")
    .split(/\r?\n/gu)
    .map((text, lineIndex) => ({
      text: normalizePaperText(text),
      lineIndex,
      lineId: null,
      fontSize: null,
      fontHeight: null,
      explicitHeading: false,
    }))
    .filter((line) => line.text);
}

function pageLabel(page, pageIndex) {
  const normalized = normalizePaperText(page.pageLabel ?? "");
  return normalized ? normalized.slice(0, 32) : String(pageIndex + 1);
}

function normalizedPageRecord(page, orderIndex) {
  if (!page || typeof page !== "object" || Array.isArray(page)) {
    throw new TypeError(`PDF page at order ${orderIndex} must be an object.`);
  }
  const pageIndex = page.pageIndex ?? orderIndex;
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    throw new TypeError(`PDF page at order ${orderIndex} has an invalid pageIndex.`);
  }
  const lines = rawLinesForPage(page);
  const text = normalizePaperText(page.text ?? lines.map((line) => line.text).join(" "));
  if (text.length > PAPER_ANALYSIS_LIMITS.charactersPerPage) throw new RangeError("Normalized page text exceeds the analysis budget.");
  const explicitHeadings = Array.isArray(page.headings)
    ? page.headings.map(lineText).filter(Boolean)
    : [];
  const textCapability = typeof page.textCapability === "string" && page.textCapability.trim()
    ? page.textCapability.trim().slice(0, 64)
    : null;
  return {
    pageIndex,
    pageLabel: pageLabel(page, pageIndex),
    text,
    lines,
    explicitHeadings,
    textCapability,
  };
}

function normalizePages(pages) {
  if (!Array.isArray(pages)) throw new TypeError("PDF pages must be an ordered array.");
  if (pages.length > PAPER_ANALYSIS_LIMITS.pages) throw new RangeError("Paper analysis exceeds the 200-page browser-local limit.");
  let documentCharacters = 0;
  for (const page of pages) {
    const lines = Array.isArray(page?.lines) ? page.lines : [];
    const headings = Array.isArray(page?.headings) ? page.headings : [];
    if (lines.length > PAPER_ANALYSIS_LIMITS.linesPerPage || headings.length > PAPER_ANALYSIS_LIMITS.linesPerPage) throw new RangeError("Paper analysis exceeds the per-page line limit.");
    let lineCharacters = 0;
    for (const line of [...lines, ...headings]) {
      const text = typeof line === "string" ? line : line?.text ?? line?.str ?? line?.value ?? "";
      if (typeof text !== "string") throw new TypeError("Paper analysis text must be a plain string.");
      lineCharacters += text.length;
    }
    if (page?.text !== undefined && typeof page.text !== "string") throw new TypeError("Paper analysis text must be a plain string.");
    const characters = Math.max(page?.text?.length || 0, lineCharacters);
    documentCharacters += characters;
    if (characters > PAPER_ANALYSIS_LIMITS.charactersPerPage || documentCharacters > PAPER_ANALYSIS_LIMITS.documentCharacters) throw new RangeError("Paper analysis exceeds its bounded extracted-text budget.");
  }
  const records = pages.map(normalizedPageRecord);
  if (records.reduce((sum, page) => sum + page.text.length, 0) > PAPER_ANALYSIS_LIMITS.documentCharacters) throw new RangeError("Normalized document text exceeds the analysis budget.");
  const seen = new Set();
  let previous = -1;
  for (const page of records) {
    if (seen.has(page.pageIndex)) throw new TypeError(`Duplicate PDF pageIndex ${page.pageIndex}.`);
    if (page.pageIndex <= previous) throw new TypeError("PDF pages must be ordered by increasing pageIndex.");
    seen.add(page.pageIndex);
    previous = page.pageIndex;
  }
  return records;
}

function headerFingerprint(value) {
  return normalizePaperText(value)
    .toLocaleLowerCase("en-US")
    .replace(/\b(?:page\s*)?\d+\b/gu, "#")
    .replace(/[^\p{L}\p{N}#]+/gu, " ")
    .trim();
}

function repeatedHeaderFingerprints(pages) {
  const occurrencePages = new Map();
  for (const page of pages) {
    const edgeLines = [page.lines[0], page.lines[1], page.lines.at(-2), page.lines.at(-1)]
      .filter(Boolean)
      .filter((line) => line.text.length >= 5 && line.text.length <= 120);
    for (const line of edgeLines) {
      const fingerprint = headerFingerprint(line.text);
      if (!fingerprint) continue;
      if (!occurrencePages.has(fingerprint)) occurrencePages.set(fingerprint, new Set());
      occurrencePages.get(fingerprint).add(page.pageIndex);
    }
  }
  const minimumOccurrences = Math.max(3, Math.ceil(pages.length * 0.4));
  return new Set(
    [...occurrencePages]
      .filter(([, pageIndexes]) => pageIndexes.size >= minimumOccurrences)
      .map(([fingerprint]) => fingerprint),
  );
}

function isLikelyPageNumber(text) {
  return /^(?:page\s*)?[ivxlcdm\d]{1,8}$/iu.test(text);
}

function words(value) {
  return normalizePaperText(value).toLocaleLowerCase("en-US").match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
}

function isTitleCaseLine(text) {
  const tokens = text.split(/\s+/gu).filter(Boolean);
  if (tokens.length < 2 || tokens.length > 12) return false;
  const meaningful = tokens.filter((token) => /\p{L}/u.test(token));
  if (!meaningful.length) return false;
  const titled = meaningful.filter((token) => /^(?:\d+(?:\.\d+)*|[A-Z][\p{L}\p{N}'-]*|and|or|of|the|in|on|for|to)$/u.test(token));
  return titled.length / meaningful.length >= 0.72;
}

function looksLikeHeading(line, medianFontMetric) {
  const text = line.text;
  if (!text || text.length > 120 || isLikelyPageNumber(text)) return false;
  if (line.explicitHeading) return true;
  if (REFERENCE_HEADINGS.has(text.toLocaleLowerCase("en-US"))) return true;
  if (/^(?:abstract|introduction|background|methods?|methodology|results?|findings|discussion|conclusions?|summary|limitations)$/iu.test(text)) return true;
  const metric = line.fontSize ?? line.fontHeight;
  if (metric !== null && medianFontMetric !== null && metric >= medianFontMetric * 1.16 && words(text).length <= 18) return true;
  if (/^(?:\d+(?:\.\d+){0,3}|[IVXLC]+)[.)]?\s+\S/iu.test(text)) return true;
  if (/^[\p{Lu}\d][\p{Lu}\d\s:&/,+-]{3,80}$/u.test(text) && /\p{Lu}/u.test(text)) return true;
  return !/[.!?;:]$/u.test(text) && isTitleCaseLine(text);
}

function medianFontMetric(lines) {
  const values = lines
    .map((line) => line.fontSize ?? line.fontHeight)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);
  if (!values.length) return null;
  return values[Math.floor(values.length / 2)];
}

function headingRecordsForPage(page, repeatedHeaders) {
  const medianMetric = medianFontMetric(page.lines);
  const explicit = new Set(page.explicitHeadings.map((heading) => heading.toLocaleLowerCase("en-US")));
  const headings = [];
  for (const line of page.lines) {
    if (repeatedHeaders.has(headerFingerprint(line.text))) continue;
    if (!explicit.has(line.text.toLocaleLowerCase("en-US")) && !looksLikeHeading(line, medianMetric)) continue;
    const key = `candidate:heading:p${page.pageIndex + 1}:${stableToken(line.text.toLocaleLowerCase("en-US"))}`;
    if (headings.some((heading) => heading.key === key)) continue;
    headings.push({
      key,
      label: line.text.slice(0, 120),
      pageIndex: page.pageIndex,
      pageLabel: page.pageLabel,
      lineIndex: line.lineIndex,
    });
  }
  for (const label of page.explicitHeadings) {
    if (repeatedHeaders.has(headerFingerprint(label))) continue;
    const key = `candidate:heading:p${page.pageIndex + 1}:${stableToken(label.toLocaleLowerCase("en-US"))}`;
    if (headings.some((heading) => heading.key === key)) continue;
    headings.push({ key, label: label.slice(0, 120), pageIndex: page.pageIndex, pageLabel: page.pageLabel, lineIndex: -1 });
  }
  return headings.sort((left, right) => left.lineIndex - right.lineIndex || left.label.localeCompare(right.label));
}

function referenceHeadingLineIndex(headings) {
  const referenceHeading = headings.find((heading) => REFERENCE_HEADINGS.has(heading.label.toLocaleLowerCase("en-US")));
  return referenceHeading?.lineIndex ?? null;
}

function referenceEntryLikelihood(lines) {
  if (!lines.length) return 0;
  const likelyEntries = lines.filter((line) => (
    /(?:^|\s)\[?\d{1,3}\]?\s*[.)]?\s+[\p{Lu}]/u.test(line.text)
    || /\b(?:19|20)\d{2}[a-z]?\b/u.test(line.text) && /\b(?:doi|vol\.?|pp?\.?|journal|proceedings|press|arxiv)\b/iu.test(line.text)
    || /\bdoi:\s*10\.\d{4,9}\//iu.test(line.text)
  ));
  return rounded(likelyEntries.length / lines.length, 3);
}

function splitSentences(value) {
  const text = normalizePaperText(value);
  if (!text) return [];
  const matches = text.matchAll(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/gu);
  return [...matches]
    .map((match) => {
      const rawText = match[0];
      const leadingWhitespace = rawText.length - rawText.trimStart().length;
      return { text: normalizePaperText(rawText), localStart: (match.index ?? 0) + leadingWhitespace };
    })
    .filter((sentence) => sentence.text);
}

function blockSourceLines(lines) {
  let cursor = 0;
  return lines.map((line) => {
    const startOffset = cursor;
    const endOffset = startOffset + line.text.length;
    cursor = endOffset + 1;
    return {
      lineIndex: line.lineIndex,
      lineId: line.lineId,
      startOffset,
      endOffset,
    };
  });
}

function pageBodyBlocks(page, headings, repeatedHeaders, inheritedReferenceRegion) {
  const headingByLine = new Map(headings.filter((heading) => heading.lineIndex >= 0).map((heading) => [heading.lineIndex, heading]));
  const referenceLineIndex = referenceHeadingLineIndex(headings);
  const blocks = [];
  let currentHeading = null;
  let buffered = [];
  let firstLineIndex = null;

  const flush = () => {
    const text = normalizePaperText(buffered.map((line) => line.text).join(" "));
    if (text) {
      blocks.push({
        text,
        heading: currentHeading,
        firstLineIndex,
        sourceLines: blockSourceLines(buffered),
        referenceRegion: inheritedReferenceRegion || (referenceLineIndex !== null && firstLineIndex > referenceLineIndex),
      });
    }
    buffered = [];
    firstLineIndex = null;
  };

  for (const line of page.lines) {
    const heading = headingByLine.get(line.lineIndex);
    if (heading) {
      flush();
      currentHeading = heading;
      continue;
    }
    if (repeatedHeaders.has(headerFingerprint(line.text)) || isLikelyPageNumber(line.text)) continue;
    if (firstLineIndex === null) firstLineIndex = line.lineIndex;
    buffered.push(line);
    if (/[.!?][”"')\]]?$/u.test(line.text) || buffered.map((entry) => entry.text).join(" ").length >= 1_200) flush();
  }
  flush();

  if (!blocks.length && page.text) {
    blocks.push({
      text: page.text,
      heading: headings[0] ?? null,
      firstLineIndex: 0,
      sourceLines: blockSourceLines(page.lines),
      referenceRegion: inheritedReferenceRegion,
    });
  }
  return { blocks, referenceLineIndex };
}

function contentTerms(value) {
  return words(value).filter((word) => word.length >= 3 && !STOP_WORDS.has(word) && !/^\d+$/u.test(word));
}

function documentTermCounts(pages, repeatedHeaders) {
  const counts = new Map();
  for (const page of pages) {
    const filtered = page.lines
      .filter((line) => !repeatedHeaders.has(headerFingerprint(line.text)))
      .map((line) => line.text)
      .join(" ");
    for (const term of contentTerms(filtered)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function cueMatch(patterns, text) {
  return patterns.some((pattern) => pattern.test(text));
}

function classifyFromText(text, headingLabel = "") {
  if (/^(?:fig(?:ure)?\.?\s*\d+)|\b(?:figure|diagram|plot|image|panel)\s+\d+[a-z]?\b/iu.test(text)) return "figure";
  if (/\b(?:equation|eq\.)\s*\(?\d+\)?\b/iu.test(text) || /\b(?:derive|solving)\b.{0,40}\bequation\b/iu.test(text)) return "equation";
  const heading = headingLabel.toLocaleLowerCase("en-US");
  if (cueMatch(DEFINITION_CUES, text)) return "term";
  if (/\b(?:abstract|conclusion|conclusions|summary)\b/iu.test(heading)) return "main_idea";
  if (cueMatch(RESULT_CUES, text) || /\b(?:result|results|findings|evaluation|experiments)\b/iu.test(heading)) return "result";
  if (cueMatch(METHOD_CUES, text) || /\b(?:method|methods|methodology|approach|materials)\b/iu.test(heading)) return "method";
  if (cueMatch(CLAIM_CUES, text)) return "main_idea";
  return "concept";
}

export function classifyCriticalIdea(text, context = {}) {
  return classifyFromText(normalizePaperText(text), normalizePaperText(context.heading ?? context.headingLabel ?? ""));
}

function citationDensity(text) {
  const citations = text.match(/\[(?:\d+[,-]?\s*)+\]|\([\p{Lu}][\p{L}'-]+(?:\s+et al\.)?,?\s+(?:19|20)\d{2}[a-z]?\)/gu) ?? [];
  return Math.min(1, citations.length / Math.max(1, words(text).length / 18));
}

function sectionWeight(headingLabel) {
  for (const [pattern, weight, signal] of HEADING_SECTION_WEIGHTS) {
    if (pattern.test(headingLabel)) return { weight, signal };
  }
  return { weight: 0, signal: null };
}

function informativeTopicLabel(headingLabel) {
  const original = normalizePaperText(headingLabel);
  const normalized = original
    .replace(/^(?:\d+(?:\.\d+){0,4}[.)]?\s+|[ivxlcdm]+[.)]?\s+)/iu, "")
    .replace(/[.:;]+$/gu, "")
    .trim();
  const lookup = normalized.toLocaleLowerCase("en-US");
  const startsWithNestedSectionNumber = /^\d+(?:\.\d+)+[.)]?\s+/u.test(original);
  if (!normalized || GENERIC_SECTION_HEADINGS.has(lookup) || REFERENCE_HEADINGS.has(lookup)) return null;
  if (!startsWithNestedSectionNumber && /[\d=<>×∈∑√]/u.test(normalized)) return null;
  const terms = contentTerms(normalized);
  if (!terms.length || terms.length > 8) return null;
  return normalized.slice(0, 96);
}

function informativeTopicKey(headingLabel) {
  const label = informativeTopicLabel(headingLabel);
  return label ? `topic:${stableToken(label.toLocaleLowerCase("en-US"))}` : null;
}

function topicSpecificityScore(topicLabel) {
  if (!topicLabel) return 0;
  const terms = contentTerms(topicLabel);
  let score = terms.length >= 2 && terms.length <= 5 ? 0.06 : 0;
  if (/\p{L}-\p{L}/u.test(topicLabel)) score += 0.14;
  if (terms.some((term) => /(?:tion|sion|ing|ment|ance|ence|ity|ics|sis|metry|graphy|algorithm|architecture|network)$/iu.test(term))) {
    score += 0.1;
  }
  if (/^(?:applications?|benchmarks?|comparisons?|evaluation|experiments?|results?|training)\b/iu.test(topicLabel)) {
    score -= 0.08;
  }
  return rounded(score, 3);
}

function isLowValueCrossReference(sentence) {
  const text = normalizePaperText(sentence);
  const documentObject = "(?:table|fig(?:ure)?|appendix|section|equation|eq\\.)";
  if (!new RegExp(`\\b${documentObject}\\s*\\(?[a-z0-9.-]+\\)?\\s+(?:summarizes?|lists?|reports?|presents?|provides?|contains?|details?)\\b`, "iu").test(text)
    && !new RegExp(`\\b(?:shown|listed|summarized|reported|presented|provided|given|detailed)\\b.{0,90}\\b${documentObject}\\s*\\(?[a-z0-9.-]+\\)?`, "iu").test(text)
    && !new RegExp(`\\b(?:top|bottom|first|second|third|final|last)\\s+(?:line|row|column|panel|entry)\\s+(?:of|in)\\s+${documentObject}\\s*\\(?[a-z0-9.-]+\\)?`, "iu").test(text)) {
    return false;
  }
  return true;
}

function isLikelyExtractionFragment(sentence) {
  const text = normalizePaperText(sentence);
  if (/^[,;:)}\]]/u.test(text)) return true;
  if (/^[+-]?\d+(?:\.\d+)?\s*,\s*(?:\p{Ll}+(?:ed|ing)|and|but|or|which|while|with)\b/u.test(text)) return true;
  return /^\d{1,3}\s+\p{Ll}+(?:ed|ing)\b/u.test(text);
}

function scoreSentence(sentence, context) {
  const sentenceWords = words(sentence);
  const uniqueTerms = new Set(contentTerms(sentence));
  const signals = [];
  let score = 0;

  if (sentenceWords.length >= 10 && sentenceWords.length <= 55) {
    score += 0.18;
    signals.push("substantive_length");
  } else if (sentenceWords.length >= 7 && sentenceWords.length <= 80) {
    score += 0.09;
  }

  if (cueMatch(CLAIM_CUES, sentence)) {
    score += 0.24;
    signals.push("claim_language");
  }
  if (cueMatch(METHOD_CUES, sentence)) {
    score += 0.12;
    signals.push("method_language");
  }
  if (cueMatch(RESULT_CUES, sentence)) {
    score += 0.17;
    signals.push("result_language");
  }
  if (cueMatch(DEFINITION_CUES, sentence)) {
    score += 0.12;
    signals.push("definition_language");
  }

  const headingSignal = sectionWeight(context.headingLabel);
  score += headingSignal.weight;
  if (headingSignal.signal) signals.push(headingSignal.signal);
  if (context.topicKey) {
    score += 0.14;
    signals.push("informative_topic_heading");
  }

  const centrality = [...uniqueTerms].reduce((total, term) => total + Math.log1p(context.termCounts.get(term) ?? 0), 0)
    / Math.max(1, uniqueTerms.size * Math.log1p(Math.max(2, context.maxTermCount)));
  score += clamp(centrality, 0, 1) * 0.18;
  if (centrality >= 0.5) signals.push("document_vocabulary");

  if (context.pageOrdinal === 0) {
    score += 0.08;
    signals.push("opening_page");
  } else if (context.pageOrdinal === context.pageCount - 1) {
    score += 0.03;
  }

  const density = citationDensity(sentence);
  if (density > 0.4) {
    score -= 0.2;
    signals.push("citation_dense");
  }
  if (context.referenceRegion) {
    score -= 0.85;
    signals.push("reference_region");
  } else if (context.referenceLikelihood >= 0.5) {
    score -= 0.45;
    signals.push("reference_like_page");
  }

  if (uniqueTerms.size / Math.max(1, sentenceWords.length) < 0.22) score -= 0.1;
  if (/^(?:copyright|all rights reserved|preprint|downloaded from|supplementary material)\b/iu.test(sentence)) score -= 0.5;
  return { score: rounded(clamp(score, 0, 1), 4), signals };
}

function conciseLabel(text, topicLabel = null) {
  const cleaned = normalizePaperText(text)
    .replace(/^\s*(?:in (?:this|the) (?:paper|study|work),?\s+|we\s+)/iu, "")
    .replace(/\s*\[[^\]]{1,60}\]/gu, "")
    .replace(/[.!?]+$/gu, "");
  if (topicLabel) return topicLabel;
  const clauses = cleaned.split(/\s*[;:]\s+|,\s+(?=(?:which|whereas|while|because|although|but)\b)/iu);
  let label = clauses[0] || cleaned;
  if (label.length > 96) {
    label = `${label.slice(0, 93).replace(/\s+\S*$/u, "")}…`;
  }
  return label || "Review this candidate idea";
}

function candidateSegments(pages, pageHeadings, repeatedHeaders) {
  const termCounts = documentTermCounts(pages, repeatedHeaders);
  let maxTermCount = 1;
  for (const count of termCounts.values()) maxTermCount = Math.max(maxTermCount, count);
  const segments = [];
  let referencesStarted = false;

  for (const [pageOrdinal, page] of pages.entries()) {
    const headings = pageHeadings.get(page.pageIndex) ?? [];
    const referenceLikelihood = referenceEntryLikelihood(page.lines);
    const { blocks, referenceLineIndex } = pageBodyBlocks(page, headings, repeatedHeaders, referencesStarted);
    let searchCursor = 0;

    for (const block of blocks) {
      for (const sentenceRecord of splitSentences(block.text)) {
        const exactText = sentenceRecord.text;
        const sentenceWords = words(exactText);
        if (sentenceWords.length < 7 || sentenceWords.length > 90 || exactText.length < 45 || exactText.length > 800) continue;
        const foundAt = page.text.indexOf(exactText, searchCursor);
        const startOffset = foundAt >= 0 ? foundAt : Math.max(0, page.text.indexOf(exactText));
        if (foundAt >= 0) searchCursor = foundAt + exactText.length;
        const headingLabel = block.heading?.label ?? "";
        const topicLabel = informativeTopicLabel(headingLabel);
        const topicKey = informativeTopicKey(headingLabel);
        const referenceRegion = block.referenceRegion;
        if (isLowValueCrossReference(exactText) || isLikelyExtractionFragment(exactText)) continue;
        const scored = scoreSentence(exactText, {
          headingLabel,
          topicKey,
          termCounts,
          maxTermCount,
          pageOrdinal,
          pageCount: pages.length,
          referenceLikelihood,
          referenceRegion,
        });
        const kind = classifyFromText(exactText, headingLabel);
        const fingerprint = exactText.toLocaleLowerCase("en-US");
        const key = `candidate:idea:p${page.pageIndex + 1}:${stableToken(fingerprint)}`;
        const sentenceLocalEnd = sentenceRecord.localStart + exactText.length;
        const lineRefs = (block.sourceLines ?? [])
          .filter((line) => line.endOffset > sentenceRecord.localStart && line.startOffset < sentenceLocalEnd)
          .map(({ lineIndex, lineId }) => ({ lineIndex, lineId }));
        segments.push({
          key,
          kind,
          label: conciseLabel(exactText, topicLabel),
          summary: exactText.slice(0, 700),
          score: scored.score,
          signals: scored.signals,
          topicKey,
          topicSpecificity: topicSpecificityScore(topicLabel),
          documentPosition: pages.length <= 1 ? 0 : pageOrdinal / (pages.length - 1),
          referenceRegion,
          sourceLocator: {
            pageIndex: page.pageIndex,
            pageLabel: page.pageLabel,
            exactText,
            startOffset,
            endOffset: startOffset + exactText.length,
            startLineIndex: lineRefs[0]?.lineIndex ?? null,
            endLineIndex: lineRefs.at(-1)?.lineIndex ?? null,
            lineRefs,
            headingKey: block.heading?.key ?? null,
            extractionSource: "pdf_text",
          },
        });
      }
    }
    if (referenceLineIndex !== null) referencesStarted = true;
  }
  return segments;
}

function normalizedOptions(options) {
  const minCandidates = clamp(
    Number.isSafeInteger(options.minCandidates) ? options.minCandidates : DEFAULT_PAPER_ANALYSIS_OPTIONS.minCandidates,
    1,
    15,
  );
  const maxCandidates = clamp(
    Number.isSafeInteger(options.maxCandidates) ? options.maxCandidates : DEFAULT_PAPER_ANALYSIS_OPTIONS.maxCandidates,
    minCandidates,
    15,
  );
  return {
    minCandidates,
    maxCandidates,
    maxCandidatesPerPage: clamp(
      Number.isSafeInteger(options.maxCandidatesPerPage)
        ? options.maxCandidatesPerPage
        : DEFAULT_PAPER_ANALYSIS_OPTIONS.maxCandidatesPerPage,
      1,
      5,
    ),
    scoreThreshold: clamp(
      Number.isFinite(options.scoreThreshold) ? options.scoreThreshold : DEFAULT_PAPER_ANALYSIS_OPTIONS.scoreThreshold,
      0,
      1,
    ),
  };
}

function selectRankedCandidates(segments, options) {
  const deduplicated = new Map();
  for (const segment of segments) {
    const fingerprint = normalizePaperText(segment.summary).toLocaleLowerCase("en-US");
    const prior = deduplicated.get(fingerprint);
    if (!prior || segment.score > prior.score) deduplicated.set(fingerprint, segment);
  }
  const ranked = [...deduplicated.values()]
    .filter((candidate) => !candidate.referenceRegion)
    .sort((left, right) => (
      right.score - left.score
      || left.sourceLocator.pageIndex - right.sourceLocator.pageIndex
      || left.sourceLocator.startOffset - right.sourceLocator.startOffset
      || left.key.localeCompare(right.key)
    ));

  const selected = [];
  const selectedKeys = new Set();
  const selectedTopicKeys = new Set();
  const pageCounts = new Map();
  const accept = (candidate, perPageLimit, { allowRepeatedTopic = false } = {}) => {
    if (selectedKeys.has(candidate.key)
      || (!allowRepeatedTopic && candidate.topicKey && selectedTopicKeys.has(candidate.topicKey))
      || (pageCounts.get(candidate.sourceLocator.pageIndex) ?? 0) >= perPageLimit) return false;
    selected.push(candidate);
    selectedKeys.add(candidate.key);
    if (candidate.topicKey) selectedTopicKeys.add(candidate.topicKey);
    pageCounts.set(candidate.sourceLocator.pageIndex, (pageCounts.get(candidate.sourceLocator.pageIndex) ?? 0) + 1);
    return true;
  };

  const topicDiversityLimit = Math.max(1, Math.ceil(options.maxCandidates * 0.8));
  const topicRanked = [...ranked].sort((left, right) => {
    const leftPriority = left.score + (1 - left.documentPosition) * 0.7 + left.topicSpecificity;
    const rightPriority = right.score + (1 - right.documentPosition) * 0.7 + right.topicSpecificity;
    return rightPriority - leftPriority
      || right.score - left.score
      || left.sourceLocator.pageIndex - right.sourceLocator.pageIndex
      || left.key.localeCompare(right.key);
  });
  for (const candidate of topicRanked) {
    if (selected.length >= topicDiversityLimit || selected.length >= options.maxCandidates) break;
    if (!candidate.topicKey || candidate.score < options.scoreThreshold) continue;
    accept(candidate, options.maxCandidatesPerPage);
  }
  for (const candidate of ranked) {
    if (candidate.score < options.scoreThreshold || selected.length >= options.maxCandidates) continue;
    accept(candidate, options.maxCandidatesPerPage);
  }
  if (selected.length < options.minCandidates) {
    for (const candidate of ranked) {
      if (selected.length >= options.minCandidates || selected.length >= options.maxCandidates) break;
      accept(candidate, options.maxCandidatesPerPage + 1, { allowRepeatedTopic: true });
    }
  }

  return selected
    .sort((left, right) => (
      right.score - left.score
      || left.sourceLocator.pageIndex - right.sourceLocator.pageIndex
      || left.key.localeCompare(right.key)
    ))
    .map((candidate, index, all) => ({
      key: candidate.key,
      rank: index + 1,
      kind: candidate.kind,
      label: candidate.label,
      summary: candidate.summary,
      salience: rounded(all.length <= 1 ? 0.9 : 0.95 - (index / (all.length - 1)) * 0.4, 3),
      criticalityScore: candidate.score,
      authority: SYSTEM_CANDIDATE_AUTHORITY,
      reviewState: "unreviewed",
      claimBoundary: PAPER_ANALYSIS_CLAIM_BOUNDARY,
      signals: candidate.signals,
      sourceLocator: candidate.sourceLocator,
    }));
}

export function createCriticalIdeaSpine(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError("Critical-idea candidates must be an array.");
  const ordered = [...candidates].sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key));
  const positions = ordered.map((candidate, index) => {
    const baseLane = KIND_LANES[candidate.kind] ?? 0;
    const conceptOffset = candidate.kind === "concept" && index > 0 ? (index % 2 ? -0.55 : 0.55) : 0;
    return {
      nodeKey: candidate.key,
      rank: candidate.rank,
      lane: candidate.kind,
      x: rounded(baseLane + conceptOffset, 3),
      y: rounded(index * 1.55, 3),
    };
  });
  const spine = ordered.slice(1).map((candidate, index) => ({
    fromKey: ordered[index].key,
    toKey: candidate.key,
    presentationOnly: true,
  }));
  return deepFreeze({
    strategy: "critical_idea_spine_v1",
    presentationOnly: true,
    semanticEdgesInferred: false,
    positions,
    spine,
  });
}

/**
 * Analyze normalized text extracted from a PDF, one page at a time.
 *
 * The result is intentionally a candidate layer. `sourceLocator` values are
 * locators for trusted viewer code; they are not source anchors or evidence
 * digests and must never be accepted directly from a model-authored command.
 */
export function analyzePaperPages(inputPages, inputOptions = {}) {
  const pages = normalizePages(inputPages);
  const options = normalizedOptions(inputOptions && typeof inputOptions === "object" ? inputOptions : {});
  const repeatedHeaders = repeatedHeaderFingerprints(pages);
  const pageHeadings = new Map(
    pages.map((page) => [page.pageIndex, headingRecordsForPage(page, repeatedHeaders)]),
  );
  const segments = candidateSegments(pages, pageHeadings, repeatedHeaders);
  const candidates = selectRankedCandidates(segments, options);
  const headings = pages.flatMap((page) => pageHeadings.get(page.pageIndex) ?? []);
  const candidateKeysByPage = new Map();
  for (const candidate of candidates) {
    const pageIndex = candidate.sourceLocator.pageIndex;
    if (!candidateKeysByPage.has(pageIndex)) candidateKeysByPage.set(pageIndex, []);
    candidateKeysByPage.get(pageIndex).push(candidate.key);
  }
  const coverage = pages.map((page) => ({
    pageIndex: page.pageIndex,
    pageLabel: page.pageLabel,
    textCapability: page.textCapability
      ?? (words(page.text).length >= 7 ? "exact_candidate" : page.text ? "weak_text" : "no_text"),
    headingKeys: (pageHeadings.get(page.pageIndex) ?? []).map((heading) => heading.key),
    candidateKeys: candidateKeysByPage.get(page.pageIndex) ?? [],
  }));
  const status = !segments.length
    ? "no_text"
    : candidates.length < options.minCandidates
      ? "candidate_limited"
      : "candidate_ready";

  return deepFreeze({
    schemaVersion: PAPER_ANALYSIS_VERSION,
    status,
    authority: SYSTEM_CANDIDATE_AUTHORITY,
    claimBoundary: PAPER_ANALYSIS_CLAIM_BOUNDARY,
    pageCount: pages.length,
    candidateCount: candidates.length,
    repeatedHeaderCount: repeatedHeaders.size,
    headings,
    coverage,
    candidates,
    layout: createCriticalIdeaSpine(candidates),
  });
}
