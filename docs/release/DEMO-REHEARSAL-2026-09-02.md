# PaperPilot demo rehearsal — 2026-09-02

**Status: fresh public technical rehearsal passed.** This was an agent-operated reader UI and native WebMCP walkthrough in a new disposable browser tab, not human acceptance. No video, audio or captions were captured. The [263-word narration draft](../DEMO-NARRATION.md) and [video plan](../DEMO-VIDEO-PLAN.md) remain preparation; human review and item-12 completion remain open.

## Artifact and paper

- [Public release entry](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=673726c); the query is a cache refresh, not an immutable deployment pin.
- Source: `673726c0f00756bdbfa57a4c1c72ab3d61062d4a`.
- Runtime fingerprint: `d66782d3e9a1d6c723f93374b3d622268801a489337245218f17cace2c1b7ace`.
- Client: Codex In-app Browser on Windows, 2026-09-02. Exact browser/model build strings were not supplied and are not invented.
- Attention Is All You Need, official arXiv v7: SHA-256 `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.
- Coverage: 15 indexed pages, 15 structural pages, 10 unreviewed idea candidates across six semantic pages. Semantic coverage remains partial; this rehearsed specimen is not an unseen-paper evaluation.

## Reader-originated annotation, then agent edits

The pointer selection initially overran a stacked formula. It was reselected to clean prose **before committing**: “To counteract this effect, we scale the dot products”. The reader controls then created **Why scale attention scores?** on page 4 at revision 2:

- Reader anchor: `anchor:reader:5707c417-e5b7-4f9a-8ed2-3ba052e22064`.
- Reader node: `node:reader:7c43368c-bfa2-42f1-9dc1-f9a17b6d8adf`.

This establishes the UI-originated anchor path, not proof that a human participant completed it. The accepted source is the short selected prose, not the discarded formula-spanning selection or the whole surrounding paragraph.

The native graph command changed revision 2→3, adding **Scaling the attention dot products** (`node:agent:9bce109d-1993-4c6a-9d37-093631fc5bc6`) and an `evidenced_by` relation (`edge:agent:2c665a99-fd64-4de4-9003-56ecc59dfe43`) to the reader node. A separate annotation command changed revision 3→4, adding **Mentor question: how could large attention scores affect softmax?** (`annotation:agent:39e6c77b-ae78-486e-9c00-13d0e20eecfe`) on the same issued source. The original reader annotation was preserved.

After fresh focus and graph reads, `stage_explain` accepted a version-2, seven-claim explanation. It remained staged and unsaved; neither its claims nor the graph were declared scientifically verified.

## Fresh native callback receipts

Each identifier below records a callback from this rehearsal, not registration or a visual replay. All six frozen tool names were invoked.

| Step / tool | Receipt | Observed result |
| --- | --- | --- |
| Initial `paperpilot.read_focus` | `callback:fa607069-ae61-42be-84c4-46e3dea636d5` | Current paper/source read |
| Literal-search `paperpilot.read_graph` | `callback:0f38a56b-3c2e-4e07-aabd-789487d17778` | Current graph search |
| Reader-source `paperpilot.read_focus` | `callback:cd623fec-b19d-43f0-8034-ad6c61cfa304` | Newly issued reader anchor |
| Reader-state `paperpilot.read_graph` | `callback:8e47b300-67ce-4a1e-ba78-4d8c241eb95c` | Revision-2 context |
| `paperpilot.apply_graph` | `callback:fcb63cfc-2e27-4e4a-b2ce-95a15d216e4f` | Concept and relation, revision 2→3 |
| `paperpilot.apply_annotation` | `callback:6769375f-ca16-4f41-87f7-1d67db0b1e1f` | Separate agent question, revision 3→4 |
| `paperpilot.focus_source` | `callback:6670576d-182a-4303-bc62-95292f43aae2` | Exact reader anchor on page 4 |
| Pre-stage `paperpilot.read_focus` | `callback:f24eb08e-b7c4-4afd-a688-d65a32d16885` | Fresh source context |
| Pre-stage `paperpilot.read_graph` | `callback:af4657b4-9f62-4e30-9629-490715450d05` | Fresh graph context |
| `paperpilot.stage_explain` | `callback:cf29a7c2-1123-4182-a181-b3ec1a9d98bd` | Version-2 seven-claim draft, not saved |
| After Undo×2 `paperpilot.read_graph` | `callback:21d9d0d4-1bb7-4b3d-b555-82e4129ed51b` | Revision 6 matches reader revision-2 digests |
| After Redo×2 `paperpilot.read_graph` | `callback:78ec0dea-f589-4ff2-950e-f98f91a7f90d` | Revision 8 matches agent revision-4 digests |
| Post-history `paperpilot.focus_source` | `callback:94a027da-9de7-4fea-b295-ba023a10a582` | After a UI jump to page 1, returned visibly to page 4 |
| Figure `paperpilot.read_focus` | `callback:746c2279-fa74-4708-89d4-3aada5fc5092` | `visual_region`, `locator_only`, `pixelUseVerified: false` |
| Figure `paperpilot.read_graph` | `callback:336390fb-4b3a-44c9-8bf2-b0b3c67e5513` | Reader-origin figure node at revision 9 |
| After annotation-card navigation `paperpilot.read_focus` | `callback:d89fa472-6582-49d4-aafb-7415b763eda3` | Original exact reader anchor on page 4; revision-9 digests unchanged |

## Reversal and source return

The agent operated the UI's **Human Undo** control twice, reaching revision 6, then **Human Redo** twice, reaching revision 8. These were UI controls, not agent tools. The reader's original annotation remained after both agent edits were undone. All three semantic digests matched the respective baseline and edited state exactly; revisions advanced without erasing history.

| Digest | Reader baseline: revision 2 = after Undo×2 at revision 6 | Agent state: revision 4 = after Redo×2 at revision 8 |
| --- | --- | --- |
| Workspace | `8ce9ccddd78a2b304963979e547a6d9fabec630cdb42379a25c1c0ad901c1f75` | `f115f322f17a185bc88d1fd9d7dc2308d79267dd4e4a59d64d5bdc11ce0842ed` |
| Graph | `ed70fabd43ebf741aeac5f7d43e38782aefbd4c18a4135d80f0d185d76ad6e9b` | `dd76e2fba8ddecc2dbf50cbde95ab0194848f408389730df29f3aba5c0a1ed92` |
| Annotation | `baafc80916f4e4a4dda2f18c1c4e3a2db0bdce6475f7aaf988302a910c5a1692` | `b0ec1bef05554812484250bfc7d29022d8fe3c0fd777b52c8d8bb91d2d68d3b1` |

After a real **Jump to page** action to page 1, the post-history native source call returned page 4. The settled 1280×720 view independently showed the exact selected line at vertical coordinates 358.8–367.3. This was a visible destination check, not only trust in a returned page number. No browser warnings or errors were returned during the rehearsal.

## Whole-page figure context

Finally, the UI jumped to page 3 and used **Use whole page**, Enter, a reader-written full-page description and **Figure** to add **Figure 1 — whole-page context** at revision 9:

- Reader figure node: `node:reader:8db36cd1-e857-4819-8634-7a6aba2d2474`.
- Reader anchor: `anchor:reader:3e0ddad9-b2eb-4cc7-a578-98767809aedb`.

The focus callback returned `visual_region` with `locator_only` and `pixelUseVerified: false`; the graph read confirmed reader origin. This was **whole-page context**, not a tight figure crop, a complete diagram description, OCR, or evidence that the agent inspected figure pixels.

After that figure step, the annotation card's **Go to source for Mentor question: how could large attention scores affect softmax? on page 4** action returned to the original exact reader anchor. The final `read_focus` receipt above confirmed revision 9 and all three digests unchanged from the figure-step state; browser diagnostics returned `[]`. The disposable tab was left with **Annotations** selected, the page-4 source visible and the workspace unsaved.

## Scope and remaining work

- No Save or Clear control was used. The rehearsal remained browser-local and unsaved; no database write or PDF export occurred. Original tabs and their saved workspaces were left untouched.
- `node scripts/check-devpost-readiness.mjs --phase technical` passed **63/63** this turn. The full 1,371-test suite was **not rerun for this rehearsal**; its earlier result belongs to the [public release proof](PUBLIC-RELEASE-PROOF-2026-09-02.md).
- This validates the rehearsed interaction sequence for the narration. It does not establish a captured or edited video, recorded audio, captions, measured video duration or public video URL.
- Human screen-reader, literal 200% zoom, forced-colors/reduced-motion and another-machine review remain open. No human acceptance or completed Devpost handoff/submission is inferred from agent-operated controls; item 12 remains incomplete.
