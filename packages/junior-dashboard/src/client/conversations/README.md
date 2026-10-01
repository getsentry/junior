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
- `TranscriptAttachments` owns wrapping for both message attachments and file
  deliveries. `ImageAttachment` owns image previews.
- `TranscriptTurnContextView` owns context content. The shared `Drawer` owns
  dismissal, focus trapping, focus return, scroll locking, and panel layout.

Review these components together in `/dev/transcripts`. Use the conversation
fixture for messages, events, activity, context, and typing. Use the attachment
fixture for file wrapping. Keep visual checks out of automated assertions;
browser tests cover opening, closing, and keyboard interaction.
