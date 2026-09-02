# PaperPilot YouTube verification — September 2, 2026

The participant supplied [PaperPilot WebMCP demo](https://youtu.be/EDpbN35rDfQ). This record verifies the video deliverable; it does not establish Devpost submission or application accessibility acceptance.

## Observed checks

- Video ID: `EDpbN35rDfQ`; title: **PaperPilot WebMCP demo**; channel: **Patrick Craig**.
- The owner's YouTube Studio page reported **Public** visibility and original filename `PaperPilot-WebMCP-demo.mp4`. No visibility, audience or other account setting was changed.
- A separate signed-out in-app-browser watch page displayed **Sign in**, loaded the same video and rendered its opening PaperPilot screen, captions and permanent disclosure footer after Play. The owner-browser player had independently advanced to `0:22 / 2:30` before pausing. This is a limited playback/access check, not a claim of watching the entire upload.
- The watch player displayed **2:30** total duration; Studio displayed **2:31**. Both observed values are below three minutes. The source MP4's independently measured duration remains **150.000 seconds**; YouTube's transcoded bytes were not downloaded or claimed to match the source hash.
- In response to “Can you confirm that the narration plays clearly when you watch the YouTube upload with sound?”, the participant answered **Yes**. This is the evidence for clear explanatory audio on the upload; it is not inferred from a volume button or an audio-track metadata field.
- Burned-in captions were visible. The watch player reported that a separate selectable caption track was unavailable; the [source SRT](../demo/PaperPilot-WebMCP-demo.srt) remains available in the repository.
- Studio currently labels the video **Made for kids**. That uploader-owned audience setting was left unchanged and flagged to the participant for review if unintended.

## Scope of readiness changes

The requirements manifest now contains the supplied public video URL and sets `demoVideoUnderThreeMinutes` and `demoVideoHasExplanatoryAudio` to true based on the checks above. All four human application accessibility/access fields remain false; their later owner-approved deferral is recorded separately in the [human-review worksheet](HUMAN-RELEASE-REVIEW-2026-09-02.md). The [freeze plan](HACKATHON-FREEZE-PLAN-2026-09-02.md) was subsequently prepared. Final Devpost verification remains pending; the video check alone does not close it.

The [recording evidence](DEMO-RECORDING-2026-09-02.md) and [source media verification](../demo/recording-verification.json) retain their original scope. No source MP4, narration, SRT, application runtime, saved PDF workspace, database or original paper was modified in this check.
