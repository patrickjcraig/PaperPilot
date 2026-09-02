# PaperPilot public release refresh — September 2, 2026

Status: current-release browser evidence is refreshed for source `9dd6bd5`; the technical readiness checker passes 63/63 controls. Human accessibility/access review and submission handoff remain open. No historical receipt is relabeled as a new run.

## Exact release, client and historical boundary

- Public URL: https://patrickjcraig.github.io/PaperPilot/webmcp/
- [Release-qualified entry](https://patrickjcraig.github.io/PaperPilot/webmcp/?release=9dd6bd5). The query refreshes entry HTML; it is not an immutable deployment pin.
- Source commit: `9dd6bd561b3fc628907e797442a252b5a8012379`.
- Runtime source/lock fingerprint: `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167`.
- [Successful Pages run 33647998514](https://github.com/patrickjcraig/PaperPilot/actions/runs/33647998514).
- Client: OpenAI Codex In-app Browser WebMCP on Windows, observed September 2, 2026. Exact browser and agent build strings were unavailable; historical version strings are not reused as current evidence.
- The [earlier 673726c proof](PUBLIC-RELEASE-PROOF-2026-09-02.md) and [archived machine-readable record](public-release-proof-673726c.json) remain historical evidence. Their receipts are not relabeled as this release.
- [Current machine-readable evidence](public-release-proof.json) contains 36 unique successful callback receipts: Attention 13, GW150914 15, and weak text 8. GW's additional foreign-source rejection has no receipt ID and is described separately below. Unsupported intake has no successful callback.

The current public entry was checked against the fingerprint before browser work. An independent read-only local check reproduced this fingerprint and verified that all 19 packaged application modules, authored runtime sources, packager and locked release inputs match the named source commit. This is not a new remote test by the static checker, or independent proof of scientific truth.

## Recorded runs

| Document | Current-release evidence | Status |
| --- | --- | --- |
| Attention Is All You Need, official arXiv v7 | The earlier same-release recording supplies 13 actual native callbacks covering all six tools, a reader-created source, reversible graph and annotation edits, and exact three-digest Undo/Redo restoration | Passed; recorded at this release, not rerun during this refresh |
| GW150914, unrelated two-column physics paper | Fresh public run: 16-page structural coverage, exact page-1 source, six-tool graph/annotation/mentor flow, two Undo and two Redo actions with exact digest restoration, final visible page-1 return | Passed; draft staged and unsaved |
| Original four-page weak-text document | Fresh public run: four navigable/indexed pages, three honestly limited; reader-side page-3 whole-page figure annotation/node, native literal search, one Undo/Redo pair with exact digests, and visible page-3 return after history | Passed with limited-text and locator-only authority |
| Non-PDF bytes presented as a PDF | Fresh public intake rejected the missing PDF signature; native discovery reported no WebMCP tools | Rejected as required; no successful callback |

Both research papers were used in earlier QA. Attention is deliberately rehearsed. These are unrelated admitted PDF identities through the shared application pipeline, not claims that the papers were previously unknown to the tester.

- Attention SHA-256: `bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697`, 15 pages.
- GW150914 SHA-256: `e5e864c23d015b69be17e5b5d51b5b462d2829353a867513414b6728f54589c4`, 16 pages.
- Weak-text document SHA-256: `de4acf347cdc1b772536dcc620d4dd95cc88a57d5007e3719b5b4208d5fc8df5`, four pages.

## Attention: retained same-release recording

The [recording proof](DEMO-RECORDING-2026-09-02.md) contains the complete 13-call sequence, source anchor, semantic digest comparisons, and [finished narrated video](../demo/PaperPilot-WebMCP-demo.mp4). Its source and fingerprint match this refresh.

The reader-side control path created an exact page-4 source whose fragment ended before the final letter and formula. The explanation explicitly acknowledged the incomplete boundary instead of repairing or extending the paper evidence. A separate agent concept and question annotation were applied at revisions 3 and 4. Two Undo actions returned the three semantic digests to the reader baseline; two Redo actions restored the edited digests at revision 8. A later whole-page figure locator remained `locator_only` with `pixelUseVerified: false`.

Those reader-side controls were operated by the demonstration agent. They exercise the UI-only authority boundary; they are not human accessibility acceptance. The seven-section mentor explanation remained unsaved.

## GW150914: fresh independent-paper run

The automatic structural map covered all 16 pages: 16 indexed, 16 structural, zero limited or failed. Semantic suggestions covered seven pages and remained `semantic_partial`; that is not complete scientific understanding. Native source navigation opened the authors' page-1 detection claim. The source anchor was `anchor:auto:idea:p1:1quybwj`, digest `a9abf76f0a08745e529ed1ceb5f045d48e56074ceb6527d755eb76d9aeefabcd`.

The agent created `node:agent:29f1251b-4a1f-45ec-a656-acd6a7a985aa` and a source-backed relation, then added a separate annotation. The graph and annotation commands returned `applied_reversible`; graph edits advanced revision 1 to 2 and the annotation advanced it to 3. Two UI Undo actions reached revision 5; two Redo actions reached revision 7. All three semantic digests matched, while the append-only revision history advanced.

| Digest | Baseline / after two Undo | Edited / after two Redo |
| --- | --- | --- |
| Workspace | `ba3d612ec92793464f69ff7734f9aa307a34e5714f4ee7b16b788af3a2923440` | `c91ccd78d17dfb0f52b4dbf9fd0e3b060d89ca30a83685e18c9c940143316ded` |
| Graph | `de3a55de7bcf5c8a0d2ad81305ac4d0c459ffa05c4489b2975213a74ab6d4889` | `da83246f6844199d215e632aedb697b52dd8bb2f046f707a11a79c025b962aa4` |
| Annotations | `de3a863652e73bdc5149aa6d3bbf4af1c731d6d1cea020c9cf6b2bfef45878f1` | `5766b75ed71176b19a2e4c3cac1e82c523f96a9bd7f6f7cd734f0379fa7193d2` |

The baseline source read was `callback:313d4f9c-40c0-43b0-b233-7cdba29ac056`; post-Undo and post-Redo reads were `callback:34119479-fbdc-4173-8382-c1ea64dffbee` and `callback:521ae28c-b1ac-43a6-9992-9e8b38f3eaaa`.

Fresh focus and bounded graph reads preceded the seven-section version-2 explanation. Its seven claim blocks comprised two document-evidence claims, two mentor interpretations, two mentor-background claims and one uncertain claim. Its staged response digest was `8e934334008beca08ef3d63605c7f9c804c99938307a4a3ae16c9efd711d4161`. The paper's detection claim is attributed to its authors, not independently verified by PaperPilot. The draft remained unsaved.

The final native source call returned page 1 and the visible continuous reader independently showed page 1. A foreign-paper `focus_source` request returned `rejected` / `not_found_in_active_paper`; the final source and all three semantic digests remained unchanged. That rejection exposed no callback receipt ID, so none is invented. GW's recorded inventory contains 16 calls: 15 successful receipt-bearing calls and this rejection. Browser warning/error diagnostics were empty.

## Weak text: locator-only recovery after history

The original four-page synthetic limited-text document was opened through the same public intake after the invalid-input attempt. It reported four indexed pages, one structural-text page, one page with semantic suggestions, three limited pages and zero failed pages. Navigable fallback coverage is not extracted text or scientific understanding. No OCR or inferred transcription is claimed.

The reader-side **Use whole page** flow created a page-3 figure annotation and `node:reader:383a03b2-3829-482b-8cde-af6713d5ed72`, with a nonvisual description. The source was `anchor:reader:3757823e-e26f-4c02-8586-78e9b751e656`, digest `bc68bf52b1d772cc62a77b1445fd1940bf632933d53df8d31fc46c0be524dc71`. Its normalized bounds covered the whole page, not an exact figure crop. Native literal graph search returned that reader-authored node.

Creation advanced revision 1 to 2. One UI Undo reached revision 3 and restored the baseline digests; one Redo reached revision 4 and restored the edited digests. These UI controls were operated by the agent tester, not a human accessibility reviewer.

| Digest | Baseline / after Undo | Edited / after Redo |
| --- | --- | --- |
| Workspace | `9243d0a33b3cfade0410755674afc801223c7f79ef2ca4d53548dad406439c6d` | `4a20f8c36240d454f47d402622be1cc41242395044fcd57df084b34a53eb8c7b` |
| Graph | `5b62a6956730a2b616dabce283f99e65e782df9685cc609de5dffff7c100888f` | `b83bb20ba8bd9926239814147b07fe8b50bec613bcb0f8c1186340df75beb4d5` |
| Annotations | `eee4506f6f6d924e5da9d4dbed7a1885ff7a7e016273ffe468575f3862518496` | `26f49fe07c0a4ca9d9def1bc64133aba654642215ea4791e5ea47af7ebebddd4` |

After moving the reader to page 1, `focus_source` returned page 3 (`callback:624f4d8f-3b95-4cdd-be71-03e53b5cdae7`). The visible reader independently confirmed page 3. The fresh source read (`callback:eaf622c7-ca43-441a-8e32-cace68da7c04`) returned `visual_region`, `locator_only`, and `pixelUseVerified: false`; all three semantic digests were still the restored revision-4 values. Browser warning/error diagnostics were empty. No Save or Clear action was performed.

## Unsupported-input boundary

The fresh invalid-header attempt displayed: “The selected file does not begin with a PDF signature. Choose another PDF.” The page reported **Not registered · paper could not be opened**; registration and workspace-saving controls were disabled. Native tool discovery separately reported no WebMCP tools. No paper digest, page count, successful callback or scientific result is invented for rejected bytes.

## Automated checks and remaining human work

The three current-release paper runs and unsupported-input rejection are bound in the canonical JSON record. Checks run after the refresh:

- `node scripts/check-devpost-readiness.mjs --phase technical`: **63/63 technical controls pass**, exit 0. Human accessibility/access remains **0/4**; submission remains **1/6**, with nine controls open overall. Technical success is not overall release readiness or submission confirmation.
- `node --test scripts/devpost-release-evidence.test.mjs`: **14/14 pass**.
- Scoped `git diff --check`: passes.
- The archived JSON deep-equals the preceding committed canonical record. The requirements manifest differs only in `publicArtifacts.releaseCommit` and `publicArtifacts.releaseProofPath`; human/submission flags are unchanged.

No checker or runtime changes are part of this refresh; the root service's full tests and Next build are not claimed as rerun. Callback totals are 13 + 15 + 8 = **36 unique successful receipts**, plus one separately documented foreign-source rejection with no returned receipt ID and the unsupported-input rejection with no tools registered.

Human screen-reader/keyboard acceptance, literal 200% browser zoom, another-machine access, public YouTube verification, participant-owned submission answers, the release freeze, and action-time Devpost submission confirmation remain separate and open. A successful technical check will not complete those controls.
