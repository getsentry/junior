# Transcript components

## Ownership

- `TranscriptRows` and `TranscriptRow` own row gaps, padding, and indent.
  Keep horizontal padding inside each row, so focus outlines are not clipped.
- `TranscriptMessageShell` owns the avatar column and message gutter.
- `TranscriptSummaryTrigger` owns disclosure padding and focus. Do not repeat
  negative margins at call sites.
- `ChatLayout` keeps the Conversation header outside the transcript scroll.
- `eventLogRows` and `filterEventLogRows` own row text and search match. The
  page step controls use them too.

## Rules

- The Automation trigger card shows the credentials from the run's dispatch
  record, not the current setting. Keep the run input collapsed, because it
  is not from a person.
- Each `Transcript` sets the panel for its own rows. A nested transcript never
  uses the panel of the page behind it.
- The page has one right panel: Conversation details, event details, or turn
  context. Closing a panel returns focus to the control that opened it.
- The URL owns the selected event in the main Conversation. Standalone
  transcripts keep selection in `ConversationEventLog`.
- A pending exit must not close a new panel or another Conversation.
- A pending fork blocks dismissal of its dialog.
- Raw JSON keeps the original ISO values. Persist the UTC/local mode, not the
  timezone.

Review with `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev`. Browser tests
cover opening, closing, and keyboard interaction, not visuals.
