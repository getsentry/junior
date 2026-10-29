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
- Display text keeps Slack tokens such as `<@U123>` and `<#C123|name>`. The
  API resolves the people in that text. It returns them as `mentions` next to
  the object that owns the text: an event, an activity preview, a Brief, or an
  Automation. Render this text with `TranscriptText` or `MentionText`. Both
  require `mentions`, so a caller cannot forget them. Do not resolve names in
  the dashboard, and do not rewrite tokens into links on the server.
- `TranscriptTurnContextView` owns context content. The shared `Drawer` adds
  its header and layout to the Base UI `Sheet` focus and dismissal boundary.

Review these components together in `/dev/transcripts`. Use the conversation
fixture for messages, events, activity, context, and typing. Use the attachment
fixture for file wrapping. Keep visual checks out of automated assertions;
browser tests cover opening, closing, and keyboard interaction.

## Conversation details

`ConversationPage` owns whether details are open. The page is keyed by the
Conversation, so switching Conversations closes details. `ConversationHeader`
only toggles details and restores focus through explicit control refs after
dismissal.

`ConversationDetails` owns one set of tabs and content. `DetailsPanel`
uses a 400px aside at 1280px and above. The chat and aside scroll separately.
Smaller windows use `BottomSheet` with a visible title and close control. The sheet and
side drawers use the shadcn Base UI `Sheet` and share the app's document
scroll lock. A resize changes the frame and keeps the selected tab. Tabs stay
fixed above the scrolling content in both layouts. The sheet title and close control sit above the tabs. Use the close
control, tap the backdrop, or press Escape to dismiss it. Base UI owns the
transition lifecycle.
A pending exit cannot close a new panel or a different Conversation.

## Event log

`ChatLayout` keeps the Conversation header outside the transcript scroll region.
`ConversationEventLog` fills the pane without a card border or page inset. Its
search toolbar and column labels stay together at the top while rows scroll.
`Transcript` shares the search value with its owner, or keeps it locally when
used alone. Event log search stays visible; the transcript search toggle is for
the Conversation view.

Rows keep time, event type, and summary in columns when the pane is at least
512px wide. Smaller panes put the summary below time and type. Model and usage
metadata share one optional line. Missing model metadata is omitted from rows.

## Event details

The URL owns the selected event in the main Conversation. `ConversationPage`
places `ConversationEventDetails` beside the log. It uses the same `DetailsPanel`
as Conversation details, and only one panel shows at a time. Selecting another
row changes the event and resets its scroll position and disclosures. Closing
returns focus to that row. Switching Conversations removes the panel.

Standalone transcripts, such as a subagent drawer, keep selection in
`ConversationEventLog`. Their event details use a nested drawer on desktop and
`BottomSheet` on smaller screens. This keeps the main log free of modal behavior
while a nested transcript retains its parent drawer's focus rules.
