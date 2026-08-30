"use client";

import {
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  CircleHelp,
  Database,
  FileSearch2,
  FileText,
  LibraryBig,
  Network,
  Play,
  Search,
  StickyNote,
} from "lucide-react";
import type {
  ConnectedResearchTool,
  DashboardMetric,
  Paper,
  ResearchActivity,
  ResearchGoal,
} from "@/lib/types";
import type { AppView } from "./app-shell";

type DashboardViewProps = {
  activities: ResearchActivity[];
  evidenceNoteCount: number;
  goal: ResearchGoal;
  metrics: DashboardMetric[];
  openQuestionCount: number;
  onNavigate: (view: AppView) => void;
  paper: Paper;
  readingStage: number;
  tools: ConnectedResearchTool[];
};

const activityIcons = {
  "paper-opened": BookOpenText,
  "note-saved": StickyNote,
  "evidence-linked": Network,
  "collection-updated": LibraryBig,
  "question-flagged": CircleHelp,
};

const toolIcons = {
  "literature-search": FileSearch2,
  "paper-source": FileText,
  "citation-library": LibraryBig,
  notes: StickyNote,
  "evidence-store": Database,
};

function shortTime(isoDate: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(isoDate));
}

export function DashboardView({ activities, evidenceNoteCount, goal, metrics, openQuestionCount, onNavigate, paper, readingStage, tools }: DashboardViewProps) {
  const displayMetrics = metrics.map((metric) => {
    if (metric.id === "evidence-notes") return { ...metric, value: evidenceNoteCount };
    if (metric.id === "open-questions") return { ...metric, value: openQuestionCount };
    return metric;
  });

  return (
    <section className="view" aria-labelledby="workspace-title">
      <div className="view-header">
        <div>
          <span className="eyebrow">Research workspace</span>
          <h1 className="view-title" id="workspace-title">Good morning, Priya.</h1>
          <p className="view-subtitle">Your trail is intact. Pick up from the evidence, not from memory.</p>
        </div>
        <div className="button-group" aria-label="Suggested next actions">
          <button className="button" type="button" onClick={() => onNavigate("discover")}>
            <Search size={14} aria-hidden="true" /> Discover papers
          </button>
          <button className="button primary" type="button" onClick={() => onNavigate("reader")}>
            <Play size={14} fill="currentColor" aria-hidden="true" /> Resume guided reading
          </button>
          <button className="button" type="button" onClick={() => onNavigate("notes")}>
            <Network size={14} aria-hidden="true" /> Review evidence
          </button>
        </div>
      </div>

      <div className="dashboard-grid">
        <article className="goal-sheet">
          <span className="goal-kicker">Current research goal</span>
          <h2 className="goal-title">{goal.title}</h2>
          <div className="goal-meta">
            <span>{goal.topicTags.length} topic threads</span>
            <span>Updated today</span>
            <span>{goal.status}</span>
          </div>
          <div className="goal-actions">
            <button className="button dark" type="button" onClick={() => onNavigate("discover")}>
              Explore literature <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </article>

        <div className="metric-stack" aria-label="Research progress">
          {displayMetrics.map((metric) => (
            <article className="metric" key={metric.id}>
              <span className="micro-label">{metric.label}</span>
              <span className="metric-value">
                {metric.value}
                {metric.id === "papers-reviewed" ? <span className="metric-total"> / 6</span> : null}
              </span>
              <span className="metric-label">{metric.detail}</span>
              {metric.trend ? <div className="metric-detail">{metric.trend}</div> : null}
            </article>
          ))}
        </div>
      </div>

      <div className="dashboard-lower">
        <div>
          <section className="panel" aria-labelledby="continue-title">
            <header className="panel-header">
              <h2 className="panel-title" id="continue-title">Continue reading</h2>
              <span className="micro-label">18 min remaining</span>
            </header>
            <div className="continue-card">
              <div className="paper-thumbnail" aria-hidden="true">μCT</div>
              <div>
                <h3 className="continue-title">{paper.title}</h3>
                <div className="continue-meta">{paper.authors.slice(0, 2).join(" · ")} et al. · {paper.year}</div>
                <div className="continue-stage">Stage {readingStage} — {readingStage === 1 ? "Frame the claim" : readingStage === 2 ? "Evaluate the evidence" : readingStage === 3 ? "Test the boundaries" : "Synthesize the next move"}</div>
                <div className="progress-track" aria-label={`${paper.readingProgress}% of paper reviewed`}>
                  <div className="progress-fill" style={{ width: `${paper.readingProgress}%` }} />
                </div>
              </div>
              <button className="button primary" type="button" onClick={() => onNavigate("reader")}>
                Continue <ArrowRight size={14} aria-hidden="true" />
              </button>
            </div>
          </section>

          <section className="panel" aria-labelledby="trail-title" style={{ marginTop: 20 }}>
            <header className="panel-header">
              <h2 className="panel-title" id="trail-title">Today&apos;s research trail</h2>
              <button className="button ghost small" type="button" onClick={() => onNavigate("notes")}>Open evidence</button>
            </header>
            <ol className="timeline">
              {activities.map((activity) => {
                const Icon = activityIcons[activity.type];
                return (
                  <li className="timeline-item" key={activity.id}>
                    <time className="timeline-time" dateTime={activity.occurredAt}>{shortTime(activity.occurredAt)}</time>
                    <span className="timeline-marker"><Icon size={9} aria-hidden="true" /></span>
                    <span className="timeline-copy">
                      <strong>{activity.title}</strong>
                      <span>{activity.detail}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <section className="panel" aria-labelledby="tools-title">
          <header className="panel-header">
            <h2 className="panel-title" id="tools-title">Connected research tools</h2>
            <span className="status-chip"><span className="status-dot ready" /> Registry online</span>
          </header>
          <div className="tool-list">
            {tools.map((tool) => {
              const Icon = toolIcons[tool.kind];
              return (
                <div className="tool-row" key={tool.id}>
                  <span className="tool-icon"><Icon size={13} aria-hidden="true" /></span>
                  <span className="tool-copy">
                    <strong>{tool.name}</strong>
                    <span>{tool.description}</span>
                  </span>
                  <span className="status-chip">
                    <span className={`status-dot${tool.status === "demo-ready" ? " ready" : ""}`} />
                    {tool.statusLabel}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="integration-note">
            <CheckCircle2 size={12} style={{ marginRight: 6, verticalAlign: -2 }} aria-hidden="true" />
            Each capability is scoped by a typed contract. No connected tool receives unrestricted access to this workspace.
          </div>
        </section>
      </div>
    </section>
  );
}
