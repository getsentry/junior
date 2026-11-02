# Automations

- `resolveViewerTaskCandidate` (`read.ts`) and `viewerAutomationCollection`
  (`collection.ts`) apply the same access rule. Change both together.
- Creator credentials run only work the creator approved. `edit-rules.ts`
  owns which changes need the creator or switch to system credentials.
- A run does not see the request that created it. Stored instructions must
  name exact targets and Slack mentions.
- `automationIdForToolCall` keeps the pre-merge id for each kind, so a
  replayed create finds its Automation.
