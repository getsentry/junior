# Automations

Shared rules for Scheduled automations and Event automations.

## Access

- A person can read and manage an Automation only when they created it, when
  its Destination is a public channel in one of their linked Slack
  workspaces, or when they ask from a Conversation whose Location is its
  Destination. Other people get not found.
- Public access comes only from the Destination directory. A missing or
  private entry grants nothing.
- `resolveViewerTaskCandidate` (`read.ts`) and `viewerAutomationCollection`
  (`collection.ts`) apply the same rule. Keep them aligned.
- Only a Turn that a person started can use the tools.

## Creator Credentials

Creator credentials run only work that the creator approved
(`edit-rules.ts`):

- Only the creator can enable creator credentials, change outcomes, or move
  the Destination.
- A non-creator change to the instruction, Schedule, or event selector
  switches to system credentials.
- A non-creator cannot resume or run now with creator credentials.
- A new outcome can target only the current Destination or the creator.

## Edits, Versions, and Runs

- A run does not see the request that created it, so instructions must name
  exact targets and Slack mentions.
- Edits compare the opaque revision from the edit read under a lock. A stale
  edit returns 409.
- An edit does not dispatch work or restart a completed Automation.
- Write a version in the same transaction and lock as the Automation, only
  when the definition changes. Activation saves a new version. Never rewrite
  history.
- `automationIdForToolCall` keeps the pre-merge id for each kind, so a
  replayed create finds its Automation.
- Deleted Automations keep run history and title. A failed run does not
  disable future runs.
