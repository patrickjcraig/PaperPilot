# Hackathon release-freeze plan

Prepared 2026-09-02 for the PaperPilot entry in The WebMCP Challenge. This records the release to preserve and the freeze procedure; it does not claim that a future freeze has already been enforced or that Devpost has received the entry.

## Release identity

- Runtime source: [`9dd6bd561b3fc628907e797442a252b5a8012379`](https://github.com/patrickjcraig/PaperPilot/commit/9dd6bd561b3fc628907e797442a252b5a8012379).
- Source/lock fingerprint: `a0d5f6636b0eace96e04011526450f0942a6a797ee5d8fafda9faf2bbf8b7167`.
- Deployment: [successful GitHub Pages run 33647998514](https://github.com/patrickjcraig/PaperPilot/actions/runs/33647998514).
- Canonical URL: [PaperPilot reader](https://patrickjcraig.github.io/PaperPilot/webmcp/).
- Anonymous HTTP recheck at `2026-09-02T17:44:58Z`: status 200, reader HTML present, versioned asset references have the expected fingerprint. This is not a second-machine human review.
- GitHub public API recheck: repository public, default branch `main`, detected license `MIT`.
- [Current release proof](PUBLIC-RELEASE-REFRESH-2026-09-02.md) and [machine-readable receipts](public-release-proof.json) bind the cross-PDF checks to this runtime.
- [Public video](https://youtu.be/EDpbN35rDfQ), [upload verification](YOUTUBE-VERIFICATION-2026-09-02.md), and [recording verification](../demo/recording-verification.json) identify the demo. The YouTube transcode is not claimed byte-identical to the repository source MP4.

## Timing and official boundary

Live event dates were fetched from the Devpost connection at `2026-09-02T17:44:17Z`:

- Submission deadline: **2026-09-03 20:00 UTC**, September 3 at 4:00 p.m. Eastern / 1:00 p.m. Pacific.
- Judging ends: **2026-09-22 00:00 UTC**, September 21 at 8:00 p.m. Eastern / 5:00 p.m. Pacific.

The [official rules](https://webmcp.devpost.com/rules), fetched at `2026-09-02T17:44:34Z`, state:

> Once the Submission Period has ended, you may not make any changes or alterations to your Submission, but you may continue to update the Project in your Devpost portfolio.

The following is PaperPilot's operational plan, not an additional organizer rule.

## Preservation procedure

1. Retain the source commit, release proof, media hashes, public video, MIT license and setup instructions. Documentation-only preparation commits do not change the runtime identity.
2. Before the deadline, review and confirm the exact Devpost title, description, links and custom answers; write only that reviewed content and verify the actual submission receipt. Record a successful receipt separately rather than marking this plan as proof of submission.
3. Preserve this judged runtime and the submitted materials from the deadline through the end of judging. Do not merge runtime changes into the Pages deployment path, manually dispatch Pages, replace the demo video, or change the entry during that interval without first checking the official rule/organizer authorization boundary.
4. The existing `.github/workflows/pages.yml` deploys on relevant runtime/package changes to `main` or manual dispatch. It remains enabled: this is a documented freeze procedure, not a claim of branch protection, disabled deployments, or an installed monitor. Do not trigger either deployment path during the freeze.
5. Keep the public reader, source repository and video accessible throughout judging. If a material availability, security, rights or privacy issue arises, document it, preserve evidence, and seek the required direction; do not silently substitute a different judged artifact.
6. Future feature work can be prepared separately from the deployed branch. Resume deployment after judging or under explicit organizer-authorized change handling, retaining this historical release record.

## Scoped human-QA deferral

The owner approved a hackathon-only deferral of the four unfinished human checks in the [human-review record](HUMAN-RELEASE-REVIEW-2026-09-02.md). Their manifest flags remain false. Public copy must disclose the lack of screen-reader acceptance, unconfirmed graph accessibility, 200% zoom and second-machine review. This does not waive security checks, native WebMCP proof, source integrity, official deliverables, or the need for a real submission confirmation.

`postDeadlineFreezePrepared` may be true because the exact release, timing and procedure are now recorded. It does not mean the future freeze has elapsed, that enforcement has been automated, or that every QA gate passed.
