# PaperPilot demo media

- [Watch the public YouTube demo](https://youtu.be/EDpbN35rDfQ).
- [Download the source demo](PaperPilot-WebMCP-demo.mp4) — 2:30, narrated and captioned.
- [Separate SRT captions](PaperPilot-WebMCP-demo.srt).
- [Media hashes and verified streams](recording-verification.json).
- [Edited scene timing](timeline.json).
- [Actual source/callback/Undo evidence](../release/DEMO-RECORDING-2026-09-02.md).

The video was captured from the public `9dd6bd5` reader on September 2, 2026. Its 447 real browser images show one Attention v7 session. A permanent footer discloses compressed timing and generic synthetic narration. Captions are phrase-timed approximately. Screen-reader, actual browser-zoom and other-machine human review remain separate work; the figure interface supplies locators, not verified agent vision.

The participant supplied the YouTube URL above. Studio's Public setting and the signed-out player were checked; the displayed duration is below three minutes, and the participant confirmed clear narration. See the [YouTube verification record](../release/YOUTUBE-VERIFICATION-2026-09-02.md). This establishes the video deliverable, not completed human application review or Devpost submission. The original MP4 remains available here for download.

Original screenshots, temporary narration audio and the portable encoder stay in ignored `tmp/`, outside the published source. `scripts/assemble-demo-video.mjs` validates captured-image content, chronological scenes, audio length and release identity before encoding. It does not create synthetic app screens. Run its pure checks with:

```sh
node --test scripts/assemble-demo-video.test.mjs
```
