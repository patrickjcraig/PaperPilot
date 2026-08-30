# WebMCP live proof record

Status: durable public release and live WebMCP execution witnessed, 2026-08-30.

## Proof contract

The public hackathon slice is deliberately narrower than PaperPilot's planned
authenticated Supabase service. It proves an arbitrary born-digital PDF can be
loaded in the browser, an exact passage can be frozen, and an agent can call two
real `document.modelContext.registerTool` tools to read that passage and stage a
reviewable mentor explanation. The PDF and saved note remain browser-local.

The slice does **not** claim server custody, OCR, figure understanding, private
model reasoning, scientific verification, or complete production readiness.

## Canonical tools

- `paperpilot.read_sources`
- `paperpilot.stage_explanation`

There is intentionally no agent-callable Save, Discard, Approve, or Verify tool.

## Local execution witnessed before release

- Client: Codex in-app browser WebMCP capability.
- URL: `http://127.0.0.1:3000/webmcp/index.html` (local pre-release only).
- Paper: unrelated public arXiv PDF, *Attention Is All You Need*, loaded through
  the same paper-agnostic file picker available to every user.
- PDF: 15 pages; page 1 rendered; embedded page text extracted in the browser.
- Frozen source: 212 words from the abstract area.
- Source-set digest:
  `171d2251a35a368158e614db311ac283ff1601a928996c8aaa84c4232c0f19a2`.
- Read callback ID:
  `webmcp-read:97a565b0-b33b-46fc-9c80-e296e4902c5c`.
- Stage proposal ID:
  `proposal:05e1f0b6-6209-4439-825f-6eba2ec51141`.
- Staged response digest:
  `026e8df2e3f484da44485a928a81f9268fbe8a733b9999dc58798f625ce63f5b`.
- Result: `read_sources` returned one bounded source and no other PaperPilot
  content; `stage_explanation` produced a seven-part mentor-style review card;
  nothing was automatically saved or verified.

This is proof of an actual WebMCP callback selected and executed by the Codex
agent through the browser capability. It is not yet the final ChatGPT desktop
site-tools recording required for the strongest Devpost autonomous-client claim.

## Public HTTPS preview witnessed before durable release

- Client: Codex in-app browser WebMCP capability.
- Public preview URL:
  `https://temporary-rapid-flint-p5aijy0.vercel.app/webmcp/`.
- Preview lifetime: temporary Vercel deployment; this URL is evidence from the
  release run, not the durable URL promoted to users.
- PDF and frozen source: the same arbitrary-PDF picker and 212-word source used
  above; no paper-specific application branch.
- Source-set digest:
  `171d2251a35a368158e614db311ac283ff1601a928996c8aaa84c4232c0f19a2`.
- Read callback ID:
  `webmcp-read:fce0d8e2-0926-41d1-a075-339ad068a9a7`.
- Stage proposal ID:
  `proposal:6dface61-0d91-45dd-b384-bc731c0d542c`.
- Staged response digest:
  `1f213f4f0011b72d36b97b15e711a142400681e245b15f28f3b1553edc128b05`.
- Result: both canonical tools were discovered and called through WebMCP at a
  public HTTPS origin; the proposal appeared for human review and was not
  automatically saved.

## Durable public verification

- Public URL: `https://patrickjcraig.github.io/PaperPilot/webmcp/`.
- Release commit:
  `c99a42dba2c4fb1c746c1146e335e665d6624c93`.
- Deployment: GitHub Pages workflow run `33326383034`, completed successfully
  with enforced HTTPS.
- Public read callback ID:
  `webmcp-read:d3747210-3b74-4866-8107-f44a5e478d15`.
- Public proposal ID:
  `proposal:a6856552-36a9-43e0-af90-c57c7c633498`.
- Public response digest:
  `276f6e83e7b7ad2243e0b370b6677a6f254e82adc93a3716f88e1ee7110ad8de`.
- Public source-set digest:
  `171d2251a35a368158e614db311ac283ff1601a928996c8aaa84c4232c0f19a2`.
- External HTTP check: the HTML returned `200` over HTTPS as `text/html`
  (12,791 bytes), and the tool adapter returned `200` as JavaScript (34,178
  bytes). The in-app browser independently loaded the GitHub Pages origin,
  rendered the 15-page PDF's first page, and reported both tools at that origin.
- Visible application proof: four events—registration, human source freeze,
  `read_sources` callback, and `stage_explanation` callback—plus the unsaved
  mentor card and human-only Save/Discard controls were present together in the
  released UI.
- Recording status: the released browser state was visually inspected and
  captured during this run. The final Devpost video has not been recorded; the
  timed shot plan and truthful-claims checklist are in `docs/DEMO-VIDEO-PLAN.md`.

Nothing was automatically saved, approved, discarded, or scientifically
verified during the agent execution. That pending human decision is an intended
authority boundary, not a missing agent capability.
