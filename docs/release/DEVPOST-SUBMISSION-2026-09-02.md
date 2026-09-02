# PaperPilot Devpost submission receipt

**Submitted and verified through the official Devpost connection on 2026-09-02.**

- Public project: [PaperPilot](https://devpost.com/software/paperpilot-kjglan).
- Event: [The WebMCP Challenge](https://webmcp.devpost.com/), slug `webmcp`, event ID `31011`.
- Project ID: `1399992`; slug: `paperpilot-kjglan`.
- Submission ID: `1153491`.
- Devpost status: `Submitted`.
- Recorded submission time: `2026-09-02T13:52:21.663-04:00` (`2026-09-02T17:52:21.663Z`).
- Live application: [public reader](https://patrickjcraig.github.io/PaperPilot/webmcp/).
- Video: [PaperPilot WebMCP demo](https://youtu.be/EDpbN35rDfQ).
- Source repository: [PaperPilot, MIT](https://github.com/patrickjcraig/PaperPilot).

## Authorization and verification

The participant explicitly answered **“yes, submit”** after reviewing the exact entry summary and authorizing both the prepared project update and the real challenge submission.

1. A fresh authenticated read found the intended existing project as an empty pre-draft with no challenge submission timestamp. The current official requirements still matched the prepared form.
2. The publication/security rescan passed: 632 tracked paths, 612 publication text files, no high-confidence exposed secrets, and no tracked credential files. Two previously classified benign placeholders were not secrets. The unrelated presentation and ignored personal-answer files were excluded from publication.
3. `update_project` saved the approved title, tagline, publication writeup, technology list, live/repository links and video to project `1399992`; it returned version `2` and the public project URL.
4. `get_project` confirmed the name, tagline, video and live URL. Its description was returned as plain text; comparison after removing Markdown presentation and normalizing whitespace matched the approved writeup. This is not a screenshot-based layout review.
5. `submit_project` returned `Submitted`, submission `1153491`, and the timestamp above. All nine required custom fields plus the existing-work explanation and judge instructions were supplied. Private entrant/residence answers are not copied into this public receipt.
6. A separate live `get_project` readback confirmed the `webmcp` entry had exactly that `submitted_at` value. The project itself was `published`, with the correct video and live website URL. A published portfolio page alone was not treated as challenge-submission proof.

The [approved publication writeup](DEVPOST-PUBLIC-WRITEUP-2026-09-02.md) is unchanged from documentation commit [`52d18af`](https://github.com/patrickjcraig/PaperPilot/commit/52d18af0cf488cfe27400a147ded42db697e5505). No thumbnail or screenshot upload was performed in this submission step.

## Scope and remaining QA

The judged runtime remains source `9dd6bd561b3fc628907e797442a252b5a8012379`, fingerprint `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167`, with the [recorded public release proof](PUBLIC-RELEASE-REFRESH-2026-09-02.md). This submission changed neither the deployed runtime nor original PDFs, local databases, video bytes or saved reader workspaces.

The participant's [hackathon-only human-QA deferral](HUMAN-RELEASE-REVIEW-2026-09-02.md) remains in force and explicitly appears in the public writeup. All four human flags remain false: primary keyboard/screen-reader flow, graph accessibility, literal 200% zoom, and second-machine access. Successful submission is not accessibility certification or scientific validation.

`submissionNotDraft` is now true because the participant authorized the final action and the official service confirmed its result. It does not claim that the participant independently inspected the final page. With that control closed, the full checker remains honestly red at **69/73**: technical **63/63**, submission **6/6**, human QA **0/4**. No checker logic or human acceptance flag was weakened.

## Deadline and preservation

Live dates fetched from Devpost at `2026-09-02T17:52:27Z` give the submission deadline as **September 3, 2026, 4:00 p.m. Eastern / 1:00 p.m. Pacific** (`2026-09-03T20:00:00Z`). Judging ends at `2026-09-22T00:00:00Z`. The [freeze plan](HACKATHON-FREEZE-PLAN-2026-09-02.md) identifies the exact artifact and preservation procedure. This record does not claim automated freeze enforcement or change the organizer's rules.
