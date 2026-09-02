# Learner Profile

## Participant

- Name: Project owner (redacted from the public repository)
- Background: Advanced technical background relevant to the build; personal specifics are intentionally omitted from the public repository.
- What brought them to the hackathon: Not asked; the guided onboarding intentionally focuses on the project and build context.

## Project Idea

- Initial idea: Build PaperPilot as an agentic scientific-literacy application powered by WebMCP. A user uploads a scientific paper, highlights text or a figure they do not understand, and asks an agent for an accessible explanation. WebMCP lets the agent interact with the PaperPilot website, the selected passage, and figure context. Provenance is central: every explanation must remain visibly grounded in the source material itself, distinguish source facts from agent interpretation, and make unsupported or hallucinated claims easier to detect. The hackathon experience should make scientific publications and specialized language more approachable without sacrificing traceability.
- First user: A general reader at roughly undergraduate level encountering an early difficult scientific paper. Assume basic prior knowledge, but not fluency in the paper's specialized language, methods, or visual conventions.
- Canonical journey: Upload a paper → read the centered PDF beside its automatic whole-paper map → highlight text or a figure region in place → ask the WebMCP-capable browser agent for help → receive an accessible explanation or reversible map/annotation change → return from the graph or evidence trail to the exact paper region → Undo/Redo or save/reject as appropriate.
- WebMCP role: PaperPilot exposes bounded tools that let the browser agent read the active spatial focus and knowledge graph, navigate between graph and PDF evidence, stage an explanation, and request reversible graph or annotation mutations. PaperPilot owns anchor validation, trusted command application, provenance capture, Undo/Redo, and human explanation review; the agent never receives Save, Discard, Verify, export, or irreversible-delete authority.
- Feature priority: The centered PDF, spatial text/figure annotations, the automatic whole-paper map, and richer WebMCP graph interaction are the first release slice. Text and figures remain equal first-class explanation surfaces; networking, Zotero, crawler acquisition, durable collaboration, and cross-paper graph UI follow after this loop is proven.
- Teaching provenance: Explanations may combine three visibly distinct authorities: statements grounded directly in the uploaded paper, general mentor background knowledge labeled as not directly stated by the paper, and additional authoritative external sources with citations. PaperPilot must not collapse these into one undifferentiated answer.
- Figure interaction: Support both whole-figure selection and an optional rectangular region inside a figure. Preserve the selected PDF-space geometry, page context, available caption, visible-region identity, and the exact evidence mode reported by the named client. The current public release remains `locator_only` with `pixelUseVerified: false`. A controlled A/B diagnostic does not promote paper regions to pixel-verified authority; any future pixel-use claim requires named-client, source-bound evidence for the specific region.
- PDF requirement: The core experience must work from user-uploaded, arbitrary scientific PDFs; the product and demo may not depend on hard-coded or content-aware behavior for curated papers. Unsupported file classes and extraction failures must be detected and explained honestly rather than hidden.
- Hackathon build target: Feature-complete by Tuesday, 2026-09-01, leaving the remaining pre-deadline window for verification, deployment, recording, and submission work.

## Technical Experience

- Experience level: Advanced and highly adaptable, with substantial technical experience.
- Languages/frameworks known: Detailed personal experience is intentionally omitted; calibrate collaboration to an advanced technical contributor.
- AI coding tools used before: Codex is in active use; other tools to be completed during guided onboarding.
- Prior experience planning before coding: Prefers enough planning to establish direction and boundaries, followed by aggressive implementation and iteration.

## Build Preferences

- Preferred pace: Concise planning followed by aggressive building, testing, and iteration.
- Likely support needs: Product scoping, WebMCP-specific experience design, secure text-and-figure provenance architecture, reliable arbitrary-PDF interaction design, verification, deployment, and Devpost packaging.
- Notes for downstream commands: The project owner can work at a technically advanced level; focus interviews on product choices, architecture tradeoffs, and demo reliability rather than introductory programming explanations. Preserve the existing PaperPilot service and its strict custody boundaries. Treat the application as pre-existing and maintain dated evidence for all new WebMCP work. The signature experience must use actual `document.modelContext.registerTool`; a fallback may preserve the walkthrough but must never be described as WebMCP execution. Text and figure explanations must expose which material was supplied to the agent, which statements are grounded, which are interpretive, and what the system cannot verify. Existing repository compliance controls remain release gates.

## Experience Direction

- Overall feel: Hip, contemporary, easy to use, and strongly accessibility-first rather than institutional or intimidating.
- Agent voice: A supportive research mentor—knowledgeable and precise, but patient with a reader encountering difficult scientific material for the first time.
- Provenance metaphor: An evidence trail connecting the selected source material, the agent's explanation, and the user's decision.
- Product inspiration: Notion-like clarity, calm document surfaces, and progressive disclosure.
- Signature demo composition: A calm research-mentor surface on the left, the scientific PDF as the large central reading surface, and a switchable knowledge-graph/evidence rail on the right. The hero interaction moves from an exact paper region to an agent explanation and grounded graph edit, back to its evidence, and through human Undo/Redo.
