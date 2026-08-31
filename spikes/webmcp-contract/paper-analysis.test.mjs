import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CRITICAL_IDEA_NODE_KINDS,
  PAPER_ANALYSIS_CLAIM_BOUNDARY,
  SYSTEM_CANDIDATE_AUTHORITY,
  analyzePaperPages,
  classifyCriticalIdea,
  createCriticalIdeaSpine,
  normalizePaperText,
} from "./paper-analysis.mjs";

const ECOLOGY_HEADER = "Journal of Estuarine Ecology | Open Research";

function ecologyPages({ noisyWhitespace = false } = {}) {
  const bodies = [
    [
      "Abstract",
      "Coastal restoration can alter food-web recovery, but the mechanisms that connect habitat structure to juvenile fish survival remain uncertain.",
      "We propose a trait-based framework that links marsh edge complexity, prey access, and predator avoidance across restored estuaries.",
      "Our results show that structurally diverse shorelines support more stable recruitment during unusually warm seasons.",
    ],
    [
      "1 Introduction",
      "Restoration success is often measured by planted area even though animal responses depend on the arrangement and quality of that habitat.",
      "This study examines whether edge complexity explains differences in fish recruitment among estuaries with similar restored area.",
      "We define functional edge as shoreline that remains accessible to juvenile fish throughout the local tidal cycle.",
    ],
    [
      "2 Methods",
      "We developed a hierarchical sampling protocol that paired acoustic habitat surveys with monthly seine observations at thirty-six shoreline sites.",
      "The model estimates site-level survival while accounting for temperature, salinity, sampling effort, and repeated observations within each estuary.",
      "Cross-validation was performed by withholding every site from one estuary before fitting the remaining observations.",
    ],
    [
      "3 Results",
      "The results show that edge complexity predicts juvenile survival more consistently than total restored area across all sampled estuaries.",
      "Survival increased by twenty percent across the observed complexity gradient, while uncertainty widened during the warmest month.",
      "Figure 2 shows that the strongest response occurs where shallow channels remain connected at low tide.",
    ],
    [
      "4 Discussion",
      "These findings suggest that restoration plans should preserve connected edge features rather than maximizing acreage alone.",
      "The association remained after controlling for salinity, although the observational design cannot establish a causal mechanism.",
      "A useful next experiment would manipulate channel access while monitoring both prey density and predator movement.",
    ],
    [
      "5 Conclusion",
      "We demonstrate that a spatial habitat measure can reveal ecological benefits that are missed by area-based reporting.",
      "The framework provides a testable way to compare restoration designs while retaining uncertainty about local causal pathways.",
    ],
    [
      "References",
      "1. Rivera, L. and Morgan, S. 2019. Journal of Coastal Systems 14: 10-21.",
      "2. Chen, A. et al. 2021. Estuarine habitat mosaics. doi:10.1000/example.1234.",
      "3. Patel, R. 2020. Proceedings of Marine Restoration Science, pp. 88-96.",
    ],
  ];

  return bodies.map((lines, pageIndex) => {
    const complete = [ECOLOGY_HEADER, ...lines, String(pageIndex + 1)];
    const transformed = noisyWhitespace
      ? complete.map((line) => `  ${line.replace(/\s+/gu, "   ")}  `)
      : complete;
    return {
      pageIndex,
      pageLabel: String(pageIndex + 1),
      text: transformed.join(noisyWhitespace ? "\n\n" : "\n"),
      lines: transformed,
    };
  });
}

function learningSciencePages() {
  return [
    {
      pageIndex: 0,
      pageLabel: "1",
      text: "Abstract\nStudents often reread technical passages without checking whether they can reconstruct the underlying explanation. We introduce a classroom routine that alternates short reading intervals with learner-generated causal diagrams. The results indicate that diagram revision improves delayed transfer more than additional rereading time.",
    },
    {
      pageIndex: 1,
      pageLabel: "2",
      text: "Methods\nWe randomly assigned twelve seminar sections to guided diagramming or time-matched rereading. The analysis model accounts for prior coursework, instructor, and clustering within each seminar section. Transfer was defined as successful explanation of a novel mechanism using concepts from the assigned article.",
    },
    {
      pageIndex: 2,
      pageLabel: "3",
      text: "Results\nStudents who revised their diagrams identified more missing causal links before the final assessment. The groups performed similarly on direct recall, but guided diagramming produced higher scores on unfamiliar applications. These findings suggest that externalizing relationships changes what learners notice while reading.",
    },
    {
      pageIndex: 3,
      pageLabel: "4",
      text: "Conclusion\nWe show that a lightweight diagram routine can support transfer without increasing total study time. Future work should test whether the same routine helps readers interpret mathematical derivations and empirical figures.",
    },
  ];
}

function mechanismArchitecturePages() {
  const bodies = [
    [
      "Abstract",
      "We introduce the Transformer, a sequence transduction architecture that replaces recurrent computation with learned attention operations.",
      "The model achieves strong translation quality while allowing substantially more parallel computation during training.",
      "Our results show that the architecture reaches competitive accuracy with lower training cost.",
    ],
    [
      "3.2.1 Scaled Dot-Product Attention",
      "Scaled dot-product attention computes compatibility scores by dividing each query-key product by the square root of the representation dimension.",
      "A softmax converts those normalized scores into weights that combine the corresponding value vectors.",
    ],
    [
      "3.2.2 Multi-Head Attention",
      "Multi-head attention projects queries, keys, and values into several learned subspaces so the model can represent distinct relationships in parallel.",
      "The projected outputs are concatenated and transformed once more before entering the next layer.",
    ],
    [
      "3.5 Positional Encoding",
      "Positional encoding adds a deterministic signal to every input embedding so token order remains available without recurrent state.",
      "The signal uses several frequencies so relative offsets can be represented across both short and long contexts.",
    ],
    [
      "6 Experiments",
      "Table 2 summarizes the dimensions and parameter counts for every evaluated configuration.",
      "The model configuration corresponding to the bottom line of Table 3 was used for all reported experiments.",
      "The evaluation shows that removing parallel attention heads reduces translation quality across both test collections.",
    ],
    [
      "6.1 Benchmark Translation",
      "The results show that the larger configuration substantially outperforms every reported baseline on two translation benchmarks.",
    ],
    [
      "6.2 Model Variations",
      "We demonstrate that increasing representation width consistently improves evaluation quality across all measured settings.",
    ],
    [
      "6.3 Parsing Evaluation",
      "The findings indicate that the same architecture achieves strong parsing accuracy with both large and limited training sets.",
    ],
  ];
  return bodies.map((lines, pageIndex) => ({
    pageIndex,
    pageLabel: String(pageIndex + 1),
    textCapability: "exact_candidate",
    text: lines.join("\n"),
    lines,
  }));
}

test("generic analysis produces a bounded, reviewable map for unrelated scientific PDFs", () => {
  const ecology = analyzePaperPages(ecologyPages());
  const learning = analyzePaperPages(learningSciencePages());

  for (const analysis of [ecology, learning]) {
    assert.equal(analysis.status, "candidate_ready");
    assert.ok(analysis.candidateCount >= 5 && analysis.candidateCount <= 15);
    assert.equal(analysis.authority, SYSTEM_CANDIDATE_AUTHORITY);
    assert.equal(analysis.claimBoundary, PAPER_ANALYSIS_CLAIM_BOUNDARY);
    assert.ok(analysis.candidates.every((candidate) => CRITICAL_IDEA_NODE_KINDS.includes(candidate.kind)));
    assert.ok(analysis.candidates.every((candidate) => candidate.reviewState === "unreviewed"));
  }
  assert.notDeepEqual(
    ecology.candidates.map((candidate) => candidate.label),
    learning.candidates.map((candidate) => candidate.label),
  );
});

test("repeated running headers, footers, and bibliography entries do not become critical ideas", () => {
  const pages = ecologyPages();
  pages.push({
    pageIndex: 7,
    pageLabel: "8",
    text: `${ECOLOGY_HEADER}\n4. Mensah, J. 2018. Journal of Applied Tidal Science 8: 33-47.\n5. Ito, K. 2022. Habitat connectivity review. doi:10.1000/example.5678.\n8`,
  });
  const analysis = analyzePaperPages(pages);

  assert.equal(analysis.repeatedHeaderCount, 1);
  assert.ok(analysis.candidates.every((candidate) => !candidate.summary.includes(ECOLOGY_HEADER)));
  assert.ok(analysis.candidates.every((candidate) => candidate.sourceLocator.pageIndex < 6));
  assert.ok(analysis.candidates.every((candidate) => !/doi:|Proceedings of Marine Restoration/iu.test(candidate.summary)));
  assert.ok(analysis.headings.some((heading) => heading.label === "References"));
});

test("candidate IDs, order, ranks, and layout are stable across irrelevant PDF whitespace", () => {
  const clean = analyzePaperPages(ecologyPages());
  const noisy = analyzePaperPages(ecologyPages({ noisyWhitespace: true }));

  assert.deepEqual(
    noisy.candidates.map(({ key, rank, kind, label, summary, salience, criticalityScore }) => ({ key, rank, kind, label, summary, salience, criticalityScore })),
    clean.candidates.map(({ key, rank, kind, label, summary, salience, criticalityScore }) => ({ key, rank, kind, label, summary, salience, criticalityScore })),
  );
  assert.deepEqual(noisy.layout, clean.layout);
});

test("each candidate retains page-owned text provenance without pretending it is an anchor", () => {
  const pages = ecologyPages();
  const analysis = analyzePaperPages(pages);

  for (const candidate of analysis.candidates) {
    const page = pages.find(({ pageIndex }) => pageIndex === candidate.sourceLocator.pageIndex);
    assert.ok(page, `missing source page for ${candidate.key}`);
    assert.equal(candidate.sourceLocator.pageLabel, page.pageLabel);
    assert.equal(candidate.sourceLocator.extractionSource, "pdf_text");
    assert.ok(normalizePaperText(page.text).includes(candidate.sourceLocator.exactText));
    assert.equal(candidate.sourceLocator.endOffset - candidate.sourceLocator.startOffset, candidate.sourceLocator.exactText.length);
    assert.ok(Array.isArray(candidate.sourceLocator.lineRefs));
    assert.equal(candidate.authority, "system_derived_candidate");
    assert.ok(!Object.hasOwn(candidate.sourceLocator, "anchorId"));
    assert.ok(!Object.hasOwn(candidate.sourceLocator, "anchorDigest"));
  }
});

test("viewer-issued line references survive a multi-line candidate without becoming geometry authority", () => {
  const analysis = analyzePaperPages([{
    pageIndex: 0,
    pageLabel: "1",
    text: "Methods We developed a sampling protocol that pairs field sensors with weekly laboratory measurements across twelve sites.",
    lines: [
      { lineIndex: 0, lineId: "pdf-line:1:0", text: "Methods", fontHeight: 18 },
      { lineIndex: 1, lineId: "pdf-line:1:1", text: "We developed a sampling protocol that pairs field sensors", fontHeight: 10 },
      { lineIndex: 2, lineId: "pdf-line:1:2", text: "with weekly laboratory measurements across twelve sites.", fontHeight: 10 },
    ],
  }]);
  const [candidate] = analysis.candidates;

  assert.deepEqual(candidate.sourceLocator.lineRefs, [
    { lineIndex: 1, lineId: "pdf-line:1:1" },
    { lineIndex: 2, lineId: "pdf-line:1:2" },
  ]);
  assert.equal(candidate.sourceLocator.startLineIndex, 1);
  assert.equal(candidate.sourceLocator.endLineIndex, 2);
  assert.ok(!Object.hasOwn(candidate.sourceLocator, "normalizedBounds"));
});

test("short, empty, and weak-text pages degrade honestly without fabricating five ideas", () => {
  const analysis = analyzePaperPages([
    { pageIndex: 0, pageLabel: "i", text: "Cover" },
    { pageIndex: 1, pageLabel: "1", text: "Scanned image." },
    { pageIndex: 2, pageLabel: "2", text: "" },
  ]);

  assert.equal(analysis.status, "no_text");
  assert.equal(analysis.candidateCount, 0);
  assert.deepEqual(analysis.coverage.map(({ textCapability }) => textCapability), ["weak_text", "weak_text", "no_text"]);
  assert.deepEqual(analysis.layout.positions, []);
  assert.equal(Object.isFrozen(analysis), true);
  assert.equal(Object.isFrozen(analysis.coverage), true);
});

test("viewer-supplied text capabilities survive analysis coverage unchanged", () => {
  const analysis = analyzePaperPages([
    { pageIndex: 0, pageLabel: "cover", text: "", textCapability: "visual_only" },
    { pageIndex: 1, pageLabel: "1", text: "", textCapability: "failed" },
    { pageIndex: 2, pageLabel: "2", text: "Sparse OCR", textCapability: "weak_text" },
    {
      pageIndex: 3,
      pageLabel: "3",
      textCapability: "exact_candidate",
      text: "We introduce a calibrated measurement procedure that compares repeated observations across independent sites.",
    },
  ], { minCandidates: 1 });

  assert.deepEqual(
    analysis.coverage.map(({ textCapability }) => textCapability),
    ["visual_only", "failed", "weak_text", "exact_candidate"],
  );
});

test("navigational table and figure references never consume critical-idea slots", () => {
  const analysis = analyzePaperPages([
    {
      pageIndex: 0,
      text: [
        "Methods",
        "We developed a calibrated model that estimates the response from repeated measurements across independent sites.",
        "Table 2 summarizes the dimensions and parameter counts for every evaluated configuration.",
        "The model configuration corresponding to the bottom line of Table 3 was used for all reported experiments.",
        "Parameter uncertainty is propagated through every stage of the estimation procedure.",
      ].join("\n"),
    },
  ], { minCandidates: 1, maxCandidates: 12, maxCandidatesPerPage: 5, scoreThreshold: 0 });

  assert.ok(analysis.candidates.some(({ summary }) => /calibrated model/iu.test(summary)));
  assert.ok(analysis.candidates.every(({ summary }) => !/Table 2 summarizes|bottom line of Table 3/iu.test(summary)));
});

test("orphaned numeric and punctuation continuations are rejected while substantive prose remains", () => {
  const analysis = analyzePaperPages([
    {
      pageIndex: 0,
      pageLabel: "1",
      text: [
        "2 Methods",
        "Approximately 30 participants completed every phase of the calibrated evaluation protocol without missing observations.",
        "0, outperforming every previously reported baseline across both independent evaluation collections.",
        ", zn), with xi denoting the input representation at position i and every variable projected independently.",
        "We developed a robust estimator that preserves uncertainty across all repeated measurements.",
      ].join("\n"),
    },
  ], { minCandidates: 1, maxCandidates: 10, maxCandidatesPerPage: 5, scoreThreshold: 0 });
  const summaries = analysis.candidates.map(({ summary }) => summary).join("\n");

  assert.match(summaries, /^Approximately 30 participants completed/mu);
  assert.match(summaries, /robust estimator/iu);
  assert.doesNotMatch(summaries, /^0, outperforming/mu);
  assert.doesNotMatch(summaries, /^, zn\)/mu);
});

test("golden scientific fixture preserves distinct mechanism topics ahead of document-navigation prose", () => {
  const first = analyzePaperPages(mechanismArchitecturePages(), {
    minCandidates: 5,
    maxCandidates: 6,
    maxCandidatesPerPage: 2,
  });
  const second = analyzePaperPages(mechanismArchitecturePages(), {
    minCandidates: 5,
    maxCandidates: 6,
    maxCandidatesPerPage: 2,
  });
  const summaries = first.candidates.map(({ summary }) => summary).join("\n");

  assert.match(summaries, /Scaled dot-product attention/iu);
  assert.match(summaries, /Multi-head attention/iu);
  assert.match(summaries, /Positional encoding/iu);
  assert.ok(first.candidates.some(({ label }) => label === "Scaled Dot-Product Attention"));
  assert.ok(first.candidates.some(({ label }) => label === "Multi-Head Attention"));
  assert.ok(first.candidates.some(({ label }) => label === "Positional Encoding"));
  assert.doesNotMatch(summaries, /Table 2 summarizes|bottom line of Table 3/iu);
  assert.ok(first.candidates.filter(({ signals }) => signals.includes("informative_topic_heading")).length >= 3);
  assert.deepEqual(first, second);
});

test("supportable figure, equation, term, method, result, and main-idea cues use allowed kinds", () => {
  assert.equal(classifyCriticalIdea("Figure 4 shows the measured response across all treatment groups."), "figure");
  assert.equal(classifyCriticalIdea("Equation 3 defines the normalized loss for each observation."), "equation");
  assert.equal(classifyCriticalIdea("Transfer refers to applying a learned mechanism in a new setting."), "term");
  assert.equal(classifyCriticalIdea("We developed an algorithm that estimates the latent state from noisy observations."), "method");
  assert.equal(classifyCriticalIdea("The results show that the intervention significantly improves delayed performance."), "result");
  assert.equal(classifyCriticalIdea("The intervention improves transfer by making causal gaps visible.", { heading: "Conclusion" }), "main_idea");
});

test("the critical-idea spine is deterministic presentation data, not inferred semantic edges", () => {
  const candidates = analyzePaperPages(ecologyPages()).candidates;
  const first = createCriticalIdeaSpine([...candidates].reverse());
  const second = createCriticalIdeaSpine(candidates);

  assert.deepEqual(first, second);
  assert.equal(first.presentationOnly, true);
  assert.equal(first.semanticEdgesInferred, false);
  assert.deepEqual(first.positions.map(({ rank }) => rank), candidates.map(({ rank }) => rank));
  assert.ok(first.positions.every((position, index) => index === 0 || position.y > first.positions[index - 1].y));
  assert.ok(first.spine.every((link) => link.presentationOnly));
});

test("analysis source contains no fixture-title, known-architecture, or identifier branching", async () => {
  const source = await readFile(new URL("./paper-analysis.mjs", import.meta.url), "utf8");
  const forbiddenFixtureTerms = ["attention is all you need", "transformer", "1706.03762"];
  for (const term of forbiddenFixtureTerms) assert.equal(source.toLocaleLowerCase("en-US").includes(term), false);
});

test("invalid page ordering and duplicate page identity fail closed", () => {
  assert.throws(
    () => analyzePaperPages([{ pageIndex: 2, text: "Long enough text for analysis." }, { pageIndex: 1, text: "Another page." }]),
    /ordered by increasing pageIndex/u,
  );
  assert.throws(
    () => analyzePaperPages([{ pageIndex: 0, text: "First." }, { pageIndex: 0, text: "Duplicate." }]),
    /Duplicate PDF pageIndex/u,
  );
});
