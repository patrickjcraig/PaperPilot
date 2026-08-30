"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookmarkPlus,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  Lightbulb,
  Link2,
  MessageSquareText,
  Network,
  Sparkles,
} from "lucide-react";
import type {
  GuidedReadingPrompt,
  Paper,
  PaperFigure,
  PaperHighlight,
  PaperSection,
  SourceLocator,
} from "@/lib/types";

type ReaderViewProps = {
  figures: PaperFigure[];
  highlights: PaperHighlight[];
  onBackToDiscover: () => void;
  onLinkHighlight: (highlight: PaperHighlight) => void;
  onOpenEvidence: () => void;
  onSavePaper: (paperId: string) => void;
  onSaveResponse: (prompt: GuidedReadingPrompt, response: string, linkEvidence: boolean) => void;
  paper: Paper;
  promptIndex: number;
  prompts: GuidedReadingPrompt[];
  setPromptIndex: (index: number) => void;
  sections: PaperSection[];
  targetLocator?: SourceLocator;
};

function createPreviewSections(paper: Paper): PaperSection[] {
  return [
    {
      id: `${paper.id}-abstract-preview`,
      paperId: paper.id,
      order: 1,
      title: "Abstract",
      kind: "abstract",
      pageStart: 1,
      pageEnd: 1,
      readingMinutes: 2,
      progress: 0,
      summaryLabel: "Claim and scope",
      paragraphs: [{ id: `${paper.id}-abstract-p1`, page: 1, text: paper.abstract }],
      figureIds: [],
    },
    {
      id: `${paper.id}-advisor-preview`,
      paperId: paper.id,
      order: 2,
      number: "1",
      title: "Why this paper is on the trail",
      kind: "introduction",
      pageStart: 2,
      pageEnd: 2,
      readingMinutes: 3,
      progress: 0,
      summaryLabel: "Reading priority",
      paragraphs: [
        { id: `${paper.id}-advisor-p1`, page: 2, text: paper.whyRead },
        {
          id: `${paper.id}-advisor-p2`,
          page: 2,
          text: "This demo record includes enough metadata to practice the reading workflow. Full paper sections would arrive through a governed PaperSourceProvider in a live workspace.",
        },
      ],
      figureIds: [],
    },
  ];
}

export function ReaderView({
  figures,
  highlights,
  onBackToDiscover,
  onLinkHighlight,
  onOpenEvidence,
  onSavePaper,
  onSaveResponse,
  paper,
  promptIndex,
  prompts,
  setPromptIndex,
  sections,
  targetLocator,
}: ReaderViewProps) {
  const displaySections = useMemo(() => (sections.length ? sections : createPreviewSections(paper)), [paper, sections]);
  const displayPrompts = useMemo<GuidedReadingPrompt[]>(() => {
    if (sections.length) return prompts;
    const previewQuestions = [
      "What problem do the authors claim to solve, and where do they draw the boundary around that claim?",
      "What evidence would most directly support the central claim, and which baseline makes the comparison meaningful?",
      "Which assumptions, specimen choices, or operating conditions could limit transfer to your research goal?",
      "What bounded statement can enter your review now, and what source should you read next to verify it?",
    ];
    return prompts.map((item, index) => {
      const groundedSection = displaySections[Math.min(index > 0 ? 1 : 0, displaySections.length - 1)];
      return {
        ...item,
        question: previewQuestions[index] ?? item.question,
        grounding: {
          paperId: paper.id,
          sectionId: groundedSection?.id,
          sectionTitle: groundedSection?.title ?? "Paper record",
          page: groundedSection?.pageStart ?? 1,
        },
        suggestedHighlightIds: [],
      };
    });
  }, [displaySections, paper.id, prompts, sections.length]);
  const [activeSectionId, setActiveSectionId] = useState(targetLocator?.sectionId ?? displaySections[0]?.id ?? "");
  const [responses, setResponses] = useState<Record<string, string>>({});

  const prompt = displayPrompts[promptIndex] ?? displayPrompts[0];
  const response = prompt ? responses[prompt.id] ?? "" : "";
  const abstractSection = displaySections.find((section) => section.kind === "abstract");
  const bodySections = displaySections.filter((section) => section.kind !== "abstract");

  useEffect(() => {
    const targetId = targetLocator?.figureId ?? targetLocator?.paragraphId ?? targetLocator?.sectionId;
    if (!targetId) return;
    const timer = window.setTimeout(() => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById(targetId)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [targetLocator, paper.id]);

  function jumpToSection(sectionId: string) {
    setActiveSectionId(sectionId);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(sectionId)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  function saveResponse(linkEvidence: boolean) {
    if (!prompt || !response.trim()) return;
    onSaveResponse(prompt, response.trim(), linkEvidence);
  }

  return (
    <section className="view reader-view" aria-label={`Guided reader for ${paper.title}`}>
      <div className="reader-toolbar">
        <div className="reader-breadcrumb">
          <button className="button ghost small" type="button" onClick={onBackToDiscover}>
            <ArrowLeft size={13} aria-hidden="true" /> <span>Results</span>
          </button>
          <span aria-hidden="true">/</span>
          <strong>{paper.shortTitle}</strong>
        </div>
        <div className="reader-toolbar-actions">
          <button className="button small" type="button" onClick={onOpenEvidence} aria-label="Open evidence trail">
            <Network size={13} aria-hidden="true" /> <span>Evidence trail</span>
          </button>
          <button className="button primary small" type="button" onClick={() => onSavePaper(paper.id)} aria-label="Add paper to collection">
            <BookmarkPlus size={13} aria-hidden="true" /> <span>Add to collection</span>
          </button>
        </div>
      </div>

      <div className="reader-layout">
        <aside className="reader-outline" aria-label="Paper outline">
          <div className="outline-head">
            <span className="micro-label">Paper outline</span>
            <div className="outline-progress">
              <div className="outline-progress-meta"><span>Reading progress</span><span>{paper.readingProgress}%</span></div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${paper.readingProgress}%` }} /></div>
            </div>
          </div>
          <ol className="outline-list">
            {displaySections.map((section) => (
              <li key={section.id}>
                <button
                  className={`outline-button${activeSectionId === section.id ? " active" : ""}`}
                  type="button"
                  onClick={() => jumpToSection(section.id)}
                >
                  <span className="outline-number">{section.number ?? String(section.order).padStart(2, "0")}</span>
                  <span>{section.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <div className="paper-canvas">
          <article className="paper-document">
            <div className="paper-running-head">
              <span>{paper.venue}</span>
              <span>{paper.year} · Demo corpus</span>
            </div>
            <h1 className="paper-title">{paper.title}</h1>
            <div className="paper-byline">{paper.authors.join(" · ")}</div>

            <section className="paper-abstract" id={abstractSection?.id}>
              <span className="micro-label">Abstract</span>
              {(abstractSection?.paragraphs ?? [{ id: "abstract", page: 1, text: paper.abstract }]).map((paragraph) => (
                <p key={paragraph.id}>{paragraph.text}</p>
              ))}
            </section>

            {bodySections.map((section) => {
              const sectionFigures = figures.filter((figure) => section.figureIds.includes(figure.id));
              return (
                <section className="paper-section" id={section.id} key={section.id}>
                  <h2 className="paper-section-heading">
                    <span className="section-index">{section.number ?? String(section.order).padStart(2, "0")}</span>
                    {section.title}
                  </h2>
                  {section.paragraphs.map((paragraph) => {
                    const highlight = highlights.find((item) => paragraph.highlightIds?.includes(item.id));
                    return highlight ? (
                      <div className="citable-passage" key={paragraph.id} id={paragraph.id}>
                        <span className="passage-label"><Highlighter size={10} style={{ verticalAlign: -2, marginRight: 5 }} aria-hidden="true" />{highlight.marginLabel} · p. {paragraph.page}</span>
                        <p>{paragraph.text}</p>
                        <button
                          className="cite-action"
                          type="button"
                          onClick={() => onLinkHighlight(highlight)}
                          aria-label={`Link highlighted passage from page ${paragraph.page} as evidence`}
                          title="Link this passage as evidence"
                        >
                          <Link2 size={12} aria-hidden="true" />
                        </button>
                      </div>
                    ) : <p key={paragraph.id}>{paragraph.text}</p>;
                  })}

                  {sectionFigures.map((figure) => (
                    <figure className="paper-figure" key={figure.id} id={figure.id}>
                      <div className="figure-graphic" role="img" aria-label={figure.altText}>
                        <div className="scan-panel"><span>FBP baseline</span></div>
                        <div className="scan-panel"><span>Angle-aware</span></div>
                        <div className="scan-panel"><span>Reference</span></div>
                      </div>
                      <figcaption className="figure-caption">
                        <strong>{figure.label}</strong> — {figure.caption}
                        <button
                          className="source-chip"
                          style={{ marginLeft: 8 }}
                          type="button"
                          onClick={() => {
                            const figureHighlight = highlights.find((item) => item.provenance.locator?.figureId === figure.id)
                              ?? highlights.find((item) => item.sectionId === section.id);
                            if (figureHighlight) onLinkHighlight(figureHighlight);
                          }}
                        >
                          <Link2 size={9} aria-hidden="true" /> Link {figure.label}
                        </button>
                      </figcaption>
                    </figure>
                  ))}
                </section>
              );
            })}
          </article>
        </div>

        {prompt ? (
          <aside className="guided-panel" aria-label="Guided reading advisor">
            <div className="guide-stage-head">
              <span className="stage-label">{prompt.stageEyebrow}</span>
              <h2 className="stage-title">{prompt.stageTitle}</h2>
              <div className="stage-dots" aria-label={`Stage ${prompt.stage} of ${displayPrompts.length}`}>
                {displayPrompts.map((item, index) => (
                  <span
                    className={`stage-dot${index < promptIndex ? " complete" : index === promptIndex ? " active" : ""}`}
                    key={item.id}
                  />
                ))}
              </div>
            </div>
            <div className="guide-context">
              <BookOpen size={12} aria-hidden="true" />
              Grounded in {prompt.grounding.sectionTitle ?? displaySections[0]?.title}
              {prompt.grounding.page ? ` · p. ${prompt.grounding.page}` : prompt.grounding.pageRange ? ` · pp. ${prompt.grounding.pageRange.join("–")}` : ""}
            </div>
            <div className="guide-body">
              <div className="guide-number" aria-hidden="true"><span>{prompt.stage}</span></div>
              <h3 className="guide-question">{prompt.question}</h3>
              <p className="guide-principle">{prompt.rationale}</p>

              <div className="cue-box">
                <span className="micro-label"><Lightbulb size={10} style={{ marginRight: 5, verticalAlign: -2 }} aria-hidden="true" />Thinking cues</span>
                <ul className="cue-list">
                  {prompt.cues.map((cue) => <li key={cue}>{cue}</li>)}
                </ul>
              </div>

              <label className="field-group">
                <span className="field-label">Your reasoning</span>
                <textarea
                  className="response-field"
                  value={response}
                  onChange={(event) => setResponses((current) => ({ ...current, [prompt.id]: event.target.value }))}
                  placeholder={prompt.responsePlaceholder}
                />
              </label>
              <div className="guide-actions">
                <button className="button" type="button" disabled={!response.trim()} onClick={() => saveResponse(false)}>
                  <MessageSquareText size={13} aria-hidden="true" /> Save as note
                </button>
                <button className="button primary" type="button" disabled={!response.trim()} onClick={() => saveResponse(true)}>
                  <Link2 size={13} aria-hidden="true" /> Link evidence
                </button>
              </div>
              <div className="guide-nav">
                <button className="button ghost small" type="button" disabled={promptIndex === 0} onClick={() => setPromptIndex(Math.max(0, promptIndex - 1))}>
                  <ChevronLeft size={13} aria-hidden="true" /> Previous
                </button>
                <button className="button ghost small" type="button" disabled={promptIndex === displayPrompts.length - 1} onClick={() => setPromptIndex(Math.min(displayPrompts.length - 1, promptIndex + 1))}>
                  Next prompt <ChevronRight size={13} aria-hidden="true" />
                </button>
              </div>
              <div className="guide-nudge">
                <Sparkles size={14} color="var(--cobalt)" aria-hidden="true" />
                <span>PaperPilot does not fill this in for you. It keeps the question, your reasoning, and the source together.</span>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
