# Learner Profile

## Participant

- Name: Project owner (redacted from the public repository)
- Background: Advanced technical background relevant to the build; personal specifics are intentionally omitted from the public repository.
- What brought them to the hackathon: Not asked; the guided onboarding intentionally focuses on the project and build context.

## Project Idea

- Initial idea: Build PaperPilot as an agentic scientific-literacy application powered by WebMCP. A user uploads a scientific paper, highlights text or a figure they do not understand, and asks an agent for an accessible explanation. WebMCP lets the agent interact with the PaperPilot website, the selected passage, and figure context. Provenance is central: every explanation must remain visibly grounded in the source material itself, distinguish source facts from agent interpretation, and make unsupported or hallucinated claims easier to detect. The hackathon experience should make scientific publications and specialized language more approachable without sacrificing traceability.
- First user: A general reader at roughly undergraduate level encountering an early difficult scientific paper. Assume basic prior knowledge, but not fluency in the paper's specialized language, methods, or visual conventions.
- Canonical journey: Upload a paper → open it in Reader → highlight a passage or select a figure region → ask the WebMCP-capable browser agent for help → receive an accessible explanation → inspect the source/agent provenance → save or reject the explanation.
- WebMCP role: PaperPilot exposes tools that let the browser agent read the active text or figure context and write a proposed explanation back into PaperPilot. The browser agent performs the explanation; PaperPilot provides bounded source access, provenance capture, review, and durable acceptance.
- Feature priority: Text passages and figures are equal first-class explanation surfaces. Scope may simplify the internal implementation, but neither may be presented merely as a future feature in the core hackathon experience.
- Teaching provenance: Explanations may combine three visibly distinct authorities: statements grounded directly in the uploaded paper, general mentor background knowledge labeled as not directly stated by the paper, and additional authoritative external sources with citations. PaperPilot must not collapse these into one undifferentiated answer.
- Figure interaction: Support both whole-figure selection and an optional rectangular region inside a figure. Preserve the full figure, crop coordinates, caption, page context, and the exact content supplied to the browser agent.
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
- Signature demo composition: A difficult passage or figure on the left, an accessible mentor-style explanation in the center, and a visible source → agent → human evidence trail on the right.
