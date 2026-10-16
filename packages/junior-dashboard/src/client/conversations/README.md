# Transcript components

Keep transcript layout in these feature components. Use the dashboard UI kit for
shared controls and overlays.

- `TranscriptRows` and `TranscriptRow` own the top-level gap, cell padding, and
  activity indent. Loading rows and the typing indicator use the same layout.
  The 4px gap and two 6px padding edges leave 16px between row content. Horizontal
  padding stays inside each mobile row's paint bounds so focus outlines are not
  clipped. Negative horizontal margins preserve the text edge.
- `TranscriptMessageShell` owns the 32px avatar column and 12px message gutter.
  `TranscriptMessageHeading` aligns authors, timestamps, and the context action.
  The action stays visible on touch devices and while open. Mouse users see it
  on message hover; keyboard users see it on focus.
- `TranscriptSummary` owns disclosure padding, hover, and keyboard focus. Use
  `flush` when the text already sits on the transcript edge. It extends the
  padded control around that text. Do not repeat negative margins at call sites.
  The caller owns the native `details` element and its content.
- Activity rows (tools, reasoning, and grouped rail events) share one
  layout: a 1rem icon column, an 8px gap, then the title and metadata.
  Expanded content sits in `transcriptActivityBodyClass` under the title.
  `TranscriptActivityNesting` tells a rail event that it is inside an activity
  group. Outside a group, the rail icon sits in the avatar column so the text
  lines up with message text.
- `TranscriptSubagentView` renders a child agent as a card with its name,
  status, run time, and title. It matches the child agent rows in the details
  drawer and opens the child transcript.
- `TranscriptAutomationTriggerView` renders the input of an Automation run as
  one card. The report names that message in `sourceTask.triggerMessageId`.
  The card shows the Automation name and a link to it. A second line shows the
  trigger, the run time, and whose credentials the run used. The credential
  part comes from the run's dispatch record, not the Automation's current
  setting. It is left out when that record is gone. The run input is not from
  a person, so it stays collapsed behind "Show prompt".
- `TranscriptAttachments` owns wrapping for both message attachments and file
  deliveries. `ImageAttachment` owns image previews.
- `TranscriptTurnContextView` owns context content. The shared `Drawer` owns
  dismissal, focus trapping, focus return, scroll locking, and panel layout.

Review these components together in `/dev/transcripts`. Use the conversation
fixture for messages, events, activity, context, and typing. Use the attachment
fixture for file wrapping. Keep visual checks out of automated assertions;
browser tests cover opening, closing, and keyboard interaction.
