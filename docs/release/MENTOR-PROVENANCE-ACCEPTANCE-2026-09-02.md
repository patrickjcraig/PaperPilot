# Claim-level mentor provenance — acceptance record

Date: 2026-09-02 (America/New_York). Guided build item 9.

## Scope and authority

The existing `paperpilot.stage_explain` now accepts an explicit version-2 claim contract. All seven sections contain claims with their own authority, exact source IDs, graph-node/edge IDs, and optional external citation IDs. Declared sources and graph items have complete, bounded coverage records. Graph references must actually have appeared in the latest bounded graph read, not merely exist somewhere in the paper. The six native tool names and result shapes remain stable.

Paper evidence, mentor interpretation, teaching background, external sources and uncertainty have visible labels. A source link proves where a claim points, not that the claim is scientifically correct. External citations are agent-declared HTTPS links marked **Not verified by PaperPilot**; they are not fetched. Region-only evidence cannot assert verified pixel use. Plain mathematical expressions remain literal text, with no new renderer or remote service.

The interface keeps the centered continuous PDF, compact claim rows, progressive section disclosures, direct source/node/edge buttons and a user-activated **Go to explanation** focus target. No transcript window was introduced. Arrival does not steal keyboard focus or erase an unfinished takeaway. Save/Discard remain human-only and are serialized with workspace callbacks; the clicked draft identity is bound before any wait. A full 200-note list rejects a new save while preserving existing notes and the current draft.

Snapshot version 3 is unchanged. Version-2 notes validate their closed shape and original canonical staged-payload digest before restoration. Legacy string notes retain exact content and show **Legacy · unclassified**, including their former paper-evidence section. Missing or removed saved references remain visible as disabled **Source incomplete** controls. Human takeaways do not modify original source or agent claims. PDF bytes and unsaved drafts/read receipts are not persisted.

## Automated verification

| Gate | Result |
| --- | --- |
| WebMCP, PDF, recovery and production-handler tests | 540 / 540 |
| Root application tests | 701 / 701 |
| Reproducible/safe Pages packaging | 4 / 4 |
| Repository TypeScript and strict WebMCP checkJs | Pass |
| ESLint | Pass, no warnings |
| Optimized Next.js production build | Pass |
| No-local-database guard | `local_database_write_frozen` |
| Staged whitespace check | Pass |

Total: **1,245 passing tests**. The new suites include 20 mentor-contract cases, 40 mentor-persistence cases and 13 actual app-handler cases. Existing model tests were expanded for claim labels, math, citations, incomplete evidence, capacity and same-ID replacement. Regression coverage includes the paused-hash Save/Discard race, source/graph coverage attacks, unsupported visual authority, unsafe links, stale focus, cancellation, rollback, legacy migration, source removal and digest tampering. Concurrency and capacity failures were reproduced in automated tests, not claimed as induced in the public browser.

## Local native-browser walkthrough

Client: Codex desktop In-app Browser on Windows, real page-defined WebMCP capability. No injected API shim, hidden-state mutation, external browser driver or storage manipulation. The isolated test origin was `http://127.0.0.1:4177/webmcp/`. Pre-publication builds were used to exercise the upgrade; the final release identity is recorded below. Browser/model build strings were not available and are not invented.

### Lossless upgrade and Attention text explanation

The byte-identical Attention v7 PDF has 15 pages and SHA-256 `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`.

1. The previous item-8 artifact staged a genuine seven-string legacy note through callback `callback:99138155-403e-4bf5-999d-72f1a101f0c4`. Response digest: `15565700880533fcb904103906b30c17344ae7d1119e0d2b5aaeb864e1fa0436`. Human **Save mentor note** persisted it.
2. After upgrading and reuploading identical bytes, the same prose returned as **Saved**, with **Legacy · unclassified** and an explicit note-wide-context disclaimer. No heading was converted into claim authority.
3. Native search found the scaling idea, `focus_source` callback `callback:ca5fc829-9234-4ad9-a75a-3edaef5309fa` returned page 4, and `read_focus` callback `callback:669e8a7a-a0b0-4b8b-8072-37828a7ff78c` returned source digest `558a968665a5c7788bde515cf7d2b97896bbd6a8872e689c1755e4b8ab8d80cd`. The bounded overview returned 21 nodes and 20 edges without truncation.
4. Version-2 staging callback `callback:ad149e81-b520-499b-9259-a3d79a4a70f2` accepted eight claims across all seven sections. Response digest: `c65fefda674366276dc655f3add363caf63ff21ccec09c91a56ad0e8bf540c4b`. Paper evidence, interpretation, arithmetic background, unverified external citation and uncertainty appeared separately. The flattened PDF fraction was explicitly called out as a limitation.
5. All three distinct reference types were activated: exact source, graph node and relationship. Fresh focus callbacks `callback:d757750f-a397-45b8-995f-097914622141`, `callback:a8f3077b-b239-4e25-b844-b472ce5ebcf5` and `callback:68d1c59f-f52e-455a-b736-60cd57dd3b5b` each confirmed the same page-4 source. **Go to explanation** focused `mentor-explanation-heading`.
6. Human Save persisted the note and separate takeaway. Reload/reupload restored its claim labels, source links and unchanged wording. The external link exposed HTTPS, `noopener noreferrer` and `no-referrer`, with explicit unverified/new-tab text. Browser warning/error logs were empty.

### Unrelated paper, region limits and removed-source recovery

GW150914 has 16 pages and SHA-256 `e5e864c23d015b69be17e5b5d51b5b462d2829353a867513414b6728f54589c4`.

1. `read_focus` callback `callback:8ba8f0cd-0e3d-4ac2-a17d-c6dc78f1ed04` returned the exact detection claim. Version-2 callback `callback:0939c3da-c932-4928-990c-b1ee29e57f05` staged seven separately classified claims, digest `b90a07b57155908a88a1835a056f36dabf70e14277ed6c3875176dbe9ff6ed81`. Activating the note's source link and rereading confirmed page 1 through `callback:f7a08150-4412-4576-93e5-24b9f70bf223`.
2. The reader used the page control, **Use whole page**, an idea label and an accessible description to create a page-2 Figure 1 region. `read_focus` callback `callback:dc566b27-8341-4ac0-91b8-0317d57eb233` returned `locator_only` and `pixelUseVerified: false`; the graph read exposed the reader-authored description and node.
3. A stage falsely claiming `client_visible_region` returned `rejected/visual_evidence_mode_mismatch`. Corrected callback `callback:15cd05b8-b626-493c-b602-3ea4fd9c4e82` staged a limited figure interpretation, digest `52caae999dad47b0c695d326797f8a32f96e875db3d050fc7eba6ca397830103`. Source coverage was **insufficient** for pixel claims, not paper evidence. The accessible description explicitly restated reader-supplied context.
4. The figure source button returned page 2 through `callback:02c43637-a1c5-4fcd-a51b-7ed29e6ff10f`. Human Save retained the note; Human Undo removed the reader-created source/node. Saving and reuploading the same PDF restored revision 3 with the original explanation intact, a changed-map notice, and disabled **Source incomplete** anchor/node controls. Nothing was substituted or resurrected. Unsaved older drafts were not restored. Browser warning/error logs were empty.

## Publication

Source checkpoint: `fe1e603e2ea086d9f61f3e51f06a8bb54d53b7e5`.

Verified runtime fingerprint: `0ae9ebe863dc048d8704111b85caff022ac319f0db4efa5033e07cc6e713e3b5`.

Published through successful [Pages run 33633510048](https://github.com/patrickjcraig/PaperPilot/actions/runs/33633510048). CI repeated strict WebMCP typechecking, all module/fixture tests and packaging verification before deployment. The [release-qualified public URL](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=fe1e603) matched the tested fingerprint in the app and vendor entry URLs. The release query avoids an older cached entry HTML; it is the same published artifact.

The public **Open the live demo** control loaded the exact official Attention v7 bytes. Native discovery returned all six tools and advertised `explanationVersion:2`. The existing older saved public workspace was preserved; no Save or Clear control was used on the public origin.

1. Public focus callback `callback:0e2b334b-f247-4ec2-ad03-1771d135010e` confirmed the document identity and revision 1. Search `callback:370b008c-ba99-4ef8-ab98-e2f328ee3369` found the scaling idea; navigation `callback:861cc75f-6573-46f3-a2b3-5d0e55267cf1` and fresh source read `callback:3674209b-d005-4800-8d87-638381ca8c00` returned the exact page-4 anchor and known source digest.
2. `apply_graph` callback `callback:20a24922-853c-417c-8e05-0b8dae5507c6` created **Why scale attention scores?** plus a grounded evidence relation at revision 2. `apply_annotation` callback `callback:6b3bb4fa-37e6-4bb9-b55a-5006ccba4da1` added **Which part is paper evidence, and which part is the mentor explanation?** on the same sentence at revision 3.
3. Fresh reads enabled version-2 stage `callback:2a74ede7-d8e1-4055-9e90-b1dc7d78a7b1`: nine claims across seven sections, with exact-source links, automatic and agent-added graph-node/edge links, teaching arithmetic, explicitly unverified external citation, and extraction uncertainty. Original response digest: `30ff81669ec6085b5269114b36ba6df3b45a18402bbb65250ba05aa1debd8b5b`.
4. A smaller graph read followed by the same explanation returned `rejected/graph_read_required` for references not returned in that bounded read. After a complete refresh, a private-host citation returned `rejected/citation_invalid`. Corrected restage `callback:0ad08712-356a-4f54-b35a-22cea27031f3` retained the same exact response digest. No failed attempt produced a successful stage.
5. The new guide's node and relationship buttons each reopened the same page-4 source, confirmed by callbacks `callback:a5f2059b-9941-49b5-9e70-fbbc7ab6318f` and `callback:2f73569a-69f9-40da-b9b6-37c15db8339d`.
6. Human Undo/Redo of the annotation reproduced its before/after workspace and annotation digests while graph state remained unchanged. Callbacks: `callback:cbfa27ba-642f-48ef-90a7-e013323e97ca` and `callback:e4ebb170-8a6b-4d36-a535-69ba8ef00e45`. Revision 5 ended at workspace digest `0bc43f9ca46e76ea74f9fdd35c1b42d41adab07343c5284d01090954727b4f42`; the staged mentor note remained intact.
7. **Go to explanation** focused the mentor heading and scrolled it into view without replacing the centered paper. Visual inspection showed the real page-4 PDF, source overlay/question, graph guide and separate paper-evidence/background labels. At a 1280×720 viewport, document width was 1265 CSS pixels for 1265 available pixels, without horizontal document overflow. Browser warning/error logs were empty. The public workspace remained **Not saved · active tab only**.

The deployed page is left open with that live, unsaved example. Item 9 is complete. Full item-10 accessibility and recovery hardening remains the next formal gate.

## Remaining boundaries

- This is the anonymous browser-local vertical slice, not the later authenticated Supabase/Zotero/crawler service.
- Source pointers and authority declarations do not scientifically verify model wording. External citations and image-pixel use remain unverified.
- Arbitrary PDFs use the shared pipeline; two unrelated born-digital papers were exercised, not every PDF format or scan. OCR is not implied.
- Item 10 still owns the full human screen-reader/browser-chrome zoom, reflow, recovery and adversarial release-hardening pause. This iteration verified claim controls/focus programmatically and in the native browser; it does not claim a completed human screen-reader walkthrough.
- Final release video, submission handoff and owner confirmation remain later gates. No database or original PDF was written. Only isolated test snapshots were saved through visible human controls; unrelated working-tree changes were excluded.
