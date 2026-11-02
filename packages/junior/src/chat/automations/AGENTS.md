# Automations

This module owns the shared rules for Scheduled automations and Event
automations: access, edits, versions, runs, and the agent tools in `tools/`.
Trigger behavior lives in `chat/scheduled-automations/` and
`chat/event-automations/`.

## Ownership

- Each Automation stores `creator_identity_id`. The user owns it when one of
  their identities has that id. `createAutomation` refuses to save without a
  stored requester identity.
- An Automation has a creator, not an Owner.

## Access

- `resolveViewerTaskCandidate` in `read.ts` and `viewerAutomationCollection`
  in `collection.ts` apply the same access rule. Keep them aligned.
- A person can read and manage an Automation when they created it, when its
  Destination is a public channel in one of their linked Slack workspaces, or
  when they ask from a Conversation whose Location is its Destination. Other
  people get not found.
- Public access comes only from the Destination directory. A missing or
  private entry does not grant access.
- Only a Turn that a person started can use the tools. A Conversation with no
  Location cannot create or move an Automation.

## Creator Credentials

The creator's credentials must run only work that the creator approved.
`edit-rules.ts` owns these rules:

- Only the creator can enable creator credentials, change outcomes, or move
  the Destination.
- A non-creator change to the instruction, Schedule, or event selector
  switches the Automation to system credentials.
- A non-creator cannot resume or run now an Automation that uses creator
  credentials (`requireCredentialStart`). Pause and delete start no work.
- A new outcome can target only the current Destination or the creator.

## Instructions

- A run does not see the request that created it.
  `requireInstructionReferences` rejects "this channel", the creator's own
  name or mention, and other people named without a Slack mention.
- Each run puts the creator mention in the `Created by:` task input line.
  It also writes the mention for "the Automation creator" in the
  instructions.

## Edits And Versions

- Edits need the opaque revision from the edit read. Scheduled saves compare
  it under the task lock. Event saves compare it under a SQL row lock. A stale
  edit returns 409. The editor keeps unsaved input on failure.
- An edit does not dispatch work or restart a completed Automation.
- A version is written in the same transaction and lock as the Automation,
  and only when the definition changes. Status changes do not make a version.
- Activating a version saves its definition as a new version. History is
  never rewritten. Activation uses the same edit rules.
- `automationIdForToolCall` keeps the pre-merge id for each kind, so a
  replayed create call finds the Automation it created.

## Runs

- Each Automation run is one row in `junior_automation_runs`. Later writes
  fill a missing `conversation_id` and keep `automation_version`.
- The heartbeat settles running runs of both kinds from their dispatch
  record, also after delete. A run without a dispatch record becomes
  `failed`.
- Deleted Automations keep their run history and title. They do not match new
  Events or Schedules.
- A failed run does not disable future runs.
