# Transcript components

Keep transcript layout in these feature components. Use the UI kit in
`../components/` for shared controls and overlays.

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

- Display text keeps Slack tokens such as `<@U123>`. The API returns
  `mentions` beside the owning object. Render with `TranscriptText` or
  `MentionText`. Do not resolve names in the dashboard, and do not rewrite
  tokens into links on the server.
- The Automation trigger card shows the credentials from the dispatch record
  of the run, not the current setting. Keep the run input collapsed, because
  it is not from a person.
- Each `Transcript` sets the panel for its own rows. A nested transcript never
  uses the panel of the page behind it.
- The page has one right panel. Conversation details, event details, and turn
  context never show at the same time. Closing a panel returns focus to the
  control that opened it.
- The URL owns the selected event in the main Conversation. Standalone
  transcripts keep selection in `ConversationEventLog`.
- A pending exit must not close a new panel or another Conversation.
- A pending fork blocks dismissal of its dialog.
- Raw JSON keeps the original ISO values. Persist the UTC/local mode, not the
  timezone.

## Checks

- Review with `JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true pnpm dev`.
- Keep visual checks out of automated assertions. Browser tests cover
  opening, closing, and keyboard interaction.
