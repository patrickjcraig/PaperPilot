"use client";

import { useMemo, useRef, useState } from "react";
import {
  BookmarkPlus,
  ChevronDown,
  CircleAlert,
  Compass,
  ExternalLink,
  PlugZap,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import type {
  LiteratureSearchHit,
  LiteratureSearchRequest,
  LiteratureSearchResponse,
  ProviderDescriptor,
} from "@/lib/integrations";
import type { Paper, PaperType, Provenance, ResearchGoal } from "@/lib/types";

type DiscoverViewProps = {
  goal: ResearchGoal;
  initialPapers: Paper[];
  initialProvider?: ProviderDescriptor;
  initialNotices?: string[];
  onManageSources: () => void;
  onOpenPaper: (paperId: string) => void;
  onSaveHit: (hit: LiteratureSearchHit) => void;
  onSearch: (request: LiteratureSearchRequest) => Promise<LiteratureSearchResponse>;
};

const defaultQuery = "limited-angle X-ray laminography semiconductor packages";

const demoDescriptor: ProviderDescriptor = {
  id: "mock-literature-search",
  displayName: "PaperPilot demo literature index",
  description: "Bundled records for a deterministic offline demo.",
  transport: "mock",
  isMock: true,
  capabilities: ["search-papers", "return-provenance"],
};

function makeDemoHit(paper: Paper, index: number): LiteratureSearchHit {
  const provenance: Provenance = {
    id: `prov-demo-discover-${paper.id}`,
    sourceType: "literature-index",
    sourceId: paper.id,
    sourceTitle: paper.title,
    sourceUrl: paper.sourceUrl,
    providerName: demoDescriptor.displayName,
    retrievedAt: "2026-08-28T12:00:00.000Z",
    accessMethod: "seeded-demo",
    locator: { paperId: paper.id },
    version: "demo-corpus-1.0",
  };
  return {
    paper,
    rank: index + 1,
    score: paper.relevanceScore,
    matchedTerms: [],
    provenance,
  };
}

export function DiscoverView({
  goal,
  initialPapers,
  initialProvider = demoDescriptor,
  initialNotices = [
    "Showing the bundled demo corpus. Run a search to query the live OpenAlex gateway.",
  ],
  onManageSources,
  onOpenPaper,
  onSaveHit,
  onSearch,
}: DiscoverViewProps) {
  const initialHits = useMemo(() => initialPapers.map(makeDemoHit), [initialPapers]);
  const [query, setQuery] = useState(defaultQuery);
  const [submittedQuery, setSubmittedQuery] = useState(defaultQuery);
  const [hits, setHits] = useState<LiteratureSearchHit[]>(initialHits);
  const [provider, setProvider] = useState<ProviderDescriptor>(initialProvider);
  const [notices, setNotices] = useState<string[]>(initialNotices);
  const [responseTotal, setResponseTotal] = useState(initialHits.length);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string>();
  const [yearFrom, setYearFrom] = useState("all");
  const [type, setType] = useState<PaperType | "all">("all");
  const [access, setAccess] = useState<"all" | "open">("all");
  const requestSequence = useRef(0);

  const visibleHits = useMemo(() => hits.filter(({ paper }) => {
    if (access === "open" && !paper.access?.isOpenAccess) return false;
    return true;
  }), [access, hits]);

  async function runSearch() {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setError("Enter at least two characters to search scholarly sources.");
      return;
    }
    const requestId = ++requestSequence.current;
    setIsSearching(true);
    setError(undefined);
    try {
      const filters: LiteratureSearchRequest["filters"] = {};
      if (yearFrom !== "all") filters.yearFrom = Number(yearFrom);
      if (type !== "all") filters.paperTypes = [type];
      const response = await onSearch({
        query: normalized,
        researchGoalId: goal.id,
        filters,
        limit: 20,
      });
      if (requestId !== requestSequence.current) return;
      setHits(response.results);
      setProvider(response.provider);
      setNotices(response.notices);
      setResponseTotal(response.total);
      setSubmittedQuery(response.query);
    } catch (searchError) {
      if (requestId !== requestSequence.current) return;
      setError(searchError instanceof Error ? searchError.message : "The literature provider could not complete this search.");
    } finally {
      if (requestId === requestSequence.current) setIsSearching(false);
    }
  }

  async function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    await runSearch();
  }

  return (
    <section className="view discover-view" aria-labelledby="discover-title">
      <div className="view-header">
        <div>
          <span className="eyebrow">Unified scholarly search</span>
          <h1 className="view-title" id="discover-title">Discover research.</h1>
          <p className="view-subtitle">Search live scholarly metadata, then preserve the provider, version, and destination before a paper enters your workspace.</p>
        </div>
        <button className="button" type="button" onClick={onManageSources}>
          <PlugZap size={14} aria-hidden="true" /> Manage sources
        </button>
      </div>

      <form className="discover-search-wrap" role="search" onSubmit={submitSearch}>
        <div className="research-search">
          <Search size={21} color="var(--cobalt)" aria-hidden="true" />
          <label className="sr-only" htmlFor="research-search">Research topic, title, author, or DOI</label>
          <input
            id="research-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search a topic, title, author, or DOI…"
            minLength={2}
            maxLength={500}
          />
          <button className="button primary" type="submit" disabled={isSearching}>
            {isSearching ? "Searching OpenAlex…" : "Search literature"}
          </button>
        </div>
        <div className="search-context">
          <Sparkles size={12} aria-hidden="true" />
          Search runs through a server-side gateway. Provider credentials and budgets never enter browser code.
        </div>
      </form>

      <div className="discover-toolbar">
        <div className="result-count" role="status" aria-live="polite">
          {isSearching ? "Searching scholarly metadata…" : `${visibleHits.length} shown · ${responseTotal.toLocaleString()} provider matches`}
        </div>
        <div className="filter-group" aria-label="Search filters">
          <label className="select-wrap">
            <span className="sr-only">Published since</span>
            <select value={yearFrom} onChange={(event) => setYearFrom(event.target.value)}>
              <option value="all">Any year</option>
              <option value="2024">Since 2024</option>
              <option value="2022">Since 2022</option>
              <option value="2020">Since 2020</option>
              <option value="2015">Since 2015</option>
            </select>
            <ChevronDown size={12} aria-hidden="true" />
          </label>
          <label className="select-wrap">
            <span className="sr-only">Filter by paper type</span>
            <select value={type} onChange={(event) => setType(event.target.value as PaperType | "all")}>
              <option value="all">Any paper type</option>
              <option value="journal article">Journal article</option>
              <option value="conference paper">Conference paper</option>
              <option value="review">Review</option>
            </select>
            <ChevronDown size={12} aria-hidden="true" />
          </label>
          <label className="select-wrap">
            <span className="sr-only">Filter by access</span>
            <select value={access} onChange={(event) => setAccess(event.target.value as "all" | "open")}>
              <option value="all">Any access</option>
              <option value="open">Open access</option>
            </select>
            <ChevronDown size={12} aria-hidden="true" />
          </label>
        </div>
      </div>

      <div className={`provider-banner${provider.isMock ? " demo" : " live"}`}>
        <span className="status-dot ready" aria-hidden="true" />
        <strong>{provider.isMock ? "Demo corpus" : `Live · ${provider.displayName}`}</strong>
        <span>Search: “{submittedQuery}”</span>
        {notices[0] ? <span>{notices[0]}</span> : null}
      </div>

      {error ? (
        <div className="search-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <div><strong>Live search is unavailable.</strong><span>{error}</span></div>
          <button className="button small" type="button" onClick={runSearch}><RotateCcw size={12} aria-hidden="true" /> Retry</button>
        </div>
      ) : null}

      <div className="paper-results" aria-busy={isSearching}>
        {visibleHits.map((hit, index) => {
          const paper = hit.paper;
          const accessLabel = paper.access?.hasFullText
            ? "Full text located"
            : paper.access?.isOpenAccess
              ? "Open access"
              : "Metadata";
          return (
            <article className="result-card" key={paper.id}>
              <div className="result-index">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <h2 className="result-title">{paper.title}</h2>
                <div className="result-authors">{paper.authors.length ? paper.authors.join(", ") : "Authors unavailable"}</div>
                <div className="result-venue">{paper.venue} · {paper.year || "Year unavailable"} · {paper.type}</div>
                <p className="result-abstract">{paper.abstractSnippet || "No abstract is available from this metadata source."}</p>
                <div className="tag-row">
                  <span className="tag source-tag">{hit.provenance.providerName}</span>
                  <span className="tag">{accessLabel}</span>
                  {paper.isRetracted ? <span className="tag caution-tag">Retracted</span> : null}
                  {paper.citationCount !== undefined ? <span className="tag">{paper.citationCount.toLocaleString()} citations</span> : null}
                  {paper.relevanceTags.slice(0, 3).map((tag) => <span className="tag" key={tag}>{tag}</span>)}
                </div>
              </div>
              <aside className="result-reason" aria-label={`Why this result: ${paper.shortTitle}`}>
                <span className="reason-heading"><Compass size={12} aria-hidden="true" /> Why this result?</span>
                <p className="reason-copy">{paper.whyRead}</p>
                <div className="provenance-mini">
                  <span>{hit.provenance.accessMethod === "api" ? "Live API record" : "Seeded demo record"}</span>
                  <span>{hit.provenance.version ? `Version ${hit.provenance.version.slice(0, 10)}` : "Version recorded on import"}</span>
                </div>
                <div className="button-group">
                  <button className="button primary small" type="button" onClick={() => onSaveHit(hit)}>
                    <BookmarkPlus size={12} aria-hidden="true" /> Save to project
                  </button>
                  {paper.isDemoRecord ? (
                    <button className="button small" type="button" onClick={() => onOpenPaper(paper.id)}>
                      Open in reader <ExternalLink size={12} aria-hidden="true" />
                    </button>
                  ) : paper.sourceUrl ? (
                    <a className="button small" href={paper.sourceUrl} target="_blank" rel="noreferrer">
                      View source <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="metadata-only-label">Metadata only</span>
                  )}
                </div>
              </aside>
            </article>
          );
        })}
      </div>

      {!isSearching && !visibleHits.length ? (
        <div className="empty-state">
          <strong>No papers match this search and filter combination.</strong>
          Change a filter or broaden the query. A valid zero-result response never falls back to demo records.
        </div>
      ) : null}
    </section>
  );
}
