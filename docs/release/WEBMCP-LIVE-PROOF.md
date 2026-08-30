# WebMCP live proof record

Status: public-preview execution witnessed; durable release verification pending,
2026-08-30.

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

## Public verification fields

Complete after the GitHub Pages deployment and final rerun:

- Durable public URL: `https://patrickjcraig.github.io/PaperPilot/webmcp/`
- Release commit: pending
- Public read callback ID: pending
- Public proposal ID: pending
- Public response digest: pending
- Cross-machine HTTP check: pending
- Browser screenshot / demo recording: pending
