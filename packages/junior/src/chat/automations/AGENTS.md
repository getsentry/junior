# Automations

Shared rules for Scheduled automations and Event automations. Trigger
behavior lives in `chat/scheduled-automations/` and `chat/event-automations/`.

## Access

- An Automation has a creator (`creator_identity_id`), not an Owner.
  `createAutomation` refuses to save without a stored requester identity.
- A person can read and manage an Automation when they created it, when its
  Destination is a public channel in one of their linked Slack workspaces, or
  when they ask from a Conversation whose Location is its Destination. Other
  people get not found.
- Public access comes only from the Destination directory. A missing or
  private entry grants nothing.
- `resolveViewerTaskCandidate` (`read.ts`) and `viewerAutomationCollection`
  (`collection.ts`) apply the same rule. Keep them aligned.
- Only a Turn that a person started can use the tools. A Conversation with no
  Location cannot create or move an Automation.

## Creator Credentials

Creator credentials run only work that the creator approved. `edit-rules.ts`
owns these rules:

- Only the creator can enable creator credentials, change outcomes, or move
  the Destination.
- A non-creator change to the instruction, Schedule, or event selector
  switches to system credentials.
- A non-creator cannot resume or run now with creator credentials
  (`requireCredentialStart`). Pause and delete start no work.
- A new outcome can target only the current Destination or the creator.

## Instructions

- A run does not see the request that created it.
  `requireInstructionReferences` rejects "this channel", the creator's own
  name or mention, and people named without a Slack mention.
- Each run puts the creator mention in the `Created by:` task input line and
  in place of "the Automation creator".

## Edits And Versions

- Edits need the opaque revision from the edit read. Scheduled saves compare
  it under the task lock, Event saves under a SQL row lock. A stale edit
  returns 409, and the editor keeps unsaved input.
- An edit does not dispatch work or restart a completed Automation.
- Write a version in the same transaction and lock as the Automation, only
  when the definition changes. Status changes make no version.
- Activating a version saves it as a new version under the same edit rules.
  Never rewrite history.
- `automationIdForToolCall` keeps the pre-merge id for each kind, so a
  replayed create finds its Automation.

## Runs

- One row per run in `junior_automation_runs`. Later writes fill a missing
  `conversation_id` and keep `automation_version`.
- The heartbeat settles running runs of both kinds from their dispatch
  record, also after delete. A run without one becomes `failed`.
- Deleted Automations keep run history and title, and match no new Events or
  Schedules.
- A failed run does not disable future runs.
