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
- `TranscriptTurnContextView` owns context content. A transcript with a
  `turnContextPanel` shows the context in the page panel. See "Page panel".
  Other transcripts, such as a subagent drawer, open a modal `Drawer`. Each
  `Transcript` sets the panel for its own rows, so a nested transcript does not
  use the panel of the page behind it. The panel keys context by message id,
  so every control for one message shows the same open state.

Review these components together in `/dev/transcripts`. Use the conversation
fixture for messages, events, activity, context, and typing. Use the attachment
fixture for file wrapping. Keep visual checks out of automated assertions;
browser tests cover opening, closing, and keyboard interaction.

## Conversation details

`ConversationPage` owns whether details are open. At 1440px and above, details
open by default. An explicit choice lasts for the current Conversation. The page
is keyed by the Conversation, so switching Conversations resets that choice.
`ConversationHeader` toggles details and restores focus through explicit control
refs after dismissal.

## Page panel

The Conversation page has one panel on the right. It shows Conversation
details, event details, or turn context. Only one shows at a time. Each uses
`DetailsPanel`: a 400px aside at 1280px and above, and a `BottomSheet` below.

- Event details and turn context show in place of Conversation details.
- When you close them, Conversation details show again if they are open. The
  details stay open by choice or by the 1440px default.
- A link that opens an event sets details to closed. When you close that
  event, no panel shows.
- The details control closes event details and turn context, then shows or
  hides Conversation details.
- Turn context belongs to the Conversation view. A view change closes it.
  Select the same context control again to close it.
- Closing a panel returns focus to the row or control that opened it.

`ConversationDetails` owns one set of tabs and content. It supplies its title and
actions to `DetailsPanel`, which uses a 400px aside at 1280px and above. The chat
and aside scroll separately.
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
Selected rows have a background and an accent edge. Up and Down select the
previous or next visible row while a row has focus. Selection stops at the
ends of the filtered list. The selected row stays clear of the fixed toolbar.
`eventLogRows` and `filterEventLogRows` own the row text and search match.
The page uses them too, so its step controls follow the same rows.

The timezone toggle uses `useEventTime` to share a UTC/local preference through
`@uidotdev/usehooks` and browser local storage. It applies to event row clocks
and detail timestamps. Local mode follows the browser timezone. The button uses
a generic zone name because a log can span standard and daylight-saving time.
Detail timestamps use the zone name for each event date. The mode, not
the timezone identifier, persists across visits and tabs. This hook belongs to
the client-rendered event viewer. Raw JSON retains the original ISO values.

## Event details

The URL owns the selected event in the main Conversation. `ConversationPage`
places `ConversationEventDetails` beside the log in the page panel. Selecting
another row changes the event and resets its scroll position and disclosures.
Closing returns focus to that row. Switching Conversations removes the panel.

The previous and next controls select the adjacent visible row. They follow
the event search, like Up and Down. They are necessary below 1280px, where the
sheet covers the log. At the ends of the list, the control is disabled but
keeps focus. The sheet title is the event type.

A linked event can be older than the loaded pages. While the event loads, the
panel stays open. Only its header shows placeholders, so it does not compete
with the log. While the transcript loads, `ConversationEventLogLoading` shows
the log toolbar, columns, and row skeletons in the event log view.

Standalone transcripts, such as a subagent drawer, keep selection in
`ConversationEventLog`. Their event details use a nested drawer on desktop and
`BottomSheet` on smaller screens. This keeps the main log free of modal behavior
while a nested transcript retains its parent drawer's focus rules. These event
details have the same previous and next controls.

`SubagentTranscriptDrawer` uses the wide `Drawer` at all widths. Below 768px
the drawer fills the screen, so the long transcript gets the most room. Its
header holds search, view, and copy actions. `BottomSheet` has no place for
them.

`ForkConversationButton` opens a `ui/dialog` form, not a drawer. The dialog
stays above event details in a docked panel or a sheet. Cancel returns focus
to the fork button. A pending fork blocks dismissal until the request ends.
