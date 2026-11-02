# Transcript components

- Keep horizontal padding inside each transcript row, so focus outlines are
  not clipped. Do not add negative margins at `TranscriptSummaryTrigger` call
  sites.
- The Automation trigger card shows the credentials from the run's dispatch
  record, not the current setting. Keep the run input collapsed, because it
  is not from a person.
- A nested `Transcript` never uses the panel of the page behind it.
- The page shows one right panel at a time. Closing a panel returns focus to
  the control that opened it.
- The URL owns the selected event in the main Conversation. Standalone
  transcripts keep it in `ConversationEventLog`.
- A pending exit must not close a new panel or another Conversation. A
  pending fork blocks dismissal of its dialog.
- Raw JSON keeps the original ISO values. Persist the UTC/local mode, not the
  timezone.
