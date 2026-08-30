# PaperPilot demo video plan

Target length: **2 minutes 30 seconds**. Record the public HTTPS release in a
WebMCP-capable browser, not localhost. Keep the PaperPilot source, mentor card,
and evidence trail visible in the same shot whenever possible.

## Narrative and shot list

| Time | Shot | Narration / proof |
| --- | --- | --- |
| 0:00–0:15 | Open on the PaperPilot promise and three-region workspace. | “Scientific papers assume vocabulary and context that first-time readers have not built yet. PaperPilot lets you point at the hard part without losing the evidence.” |
| 0:15–0:35 | Upload a real, previously unseen born-digital scientific PDF. Show page 1 and the extracted transcript. | State the honest boundary: the hackathon slice processes the PDF in the browser and does not claim server custody or OCR. |
| 0:35–0:55 | Highlight or choose a difficult abstract passage and freeze it. Open the sharing preview/digest. | “Only this frozen passage can be returned. Other papers, notes, projects, and library content stay out of the tool result.” |
| 0:55–1:25 | Ask the browser agent to use PaperPilot. Show the site-tool activity, then the visible `read_sources` and `stage_explanation` callback events. | Name the two tools. Emphasize that registration is not a call; the callback receipts are the proof that execution happened. |
| 1:25–1:55 | Read the plain-language explanation, key terms, paper connection, mentor background, and limitations. | “Paper statements and mentor knowledge are labeled separately. PaperPilot validates the response shape; it does not certify scientific truth.” |
| 1:55–2:15 | Show that the tool list has no Save/Approve/Verify action. Add a short personal takeaway and click **Save to this browser**. | “The agent proposes. The reader decides what to keep.” |
| 2:15–2:30 | Show the completed source → WebMCP → human trail and download the JSON provenance receipt. End on the repository/live URL. | Close: “PaperPilot turns a static paper into an accessible teaching surface while preserving what the agent actually saw.” |

## Recording checklist

- Use the exact public release URL and record its Git commit.
- Use an unrelated scientific PDF with a clean embedded text layer; rehearse once,
  but do not add paper-specific application logic.
- Capture the browser’s WebMCP/site-tools indicator and PaperPilot’s matching
  callback IDs in the same recording.
- Keep the PDF free of private or unpublished content.
- Use 125–150% UI scaling if needed so the selected passage, mentor explanation,
  and evidence trail remain legible in the final export.
- Include captions or a clean voice-over transcript.
- Do not claim server persistence, OCR, figure understanding, private agent
  reasoning, citation verification, or hallucination prevention in this slice.
- End with the live URL, public GitHub repository, MIT license, and one-sentence
  description of the next slice: durable Supabase custody plus figure regions.

## Backup cut

If the browser agent is slow during recording, keep a continuous screen capture
running and trim only dead time. Do not replace the callback sequence with a
mock. If WebMCP is unavailable, stop and fix the client/release tuple before
recording rather than presenting the local fallback as native execution.
