# Automations

This module projects scheduled and event automations for signed-in users. It
includes automations that the user owns and automations in public destinations
in the user's linked Slack workspaces.

Each Automation stores `creator_identity_id`, the Junior identity that created
it. A foreign key to `junior_identities` makes sure that identity exists. The
user owns an Automation when one of their identities has that ID. This
rule is the same for both kinds. `createAutomation` refuses to save an
Automation when the requester has no stored identity. Migration 0058 sets the
identity on event automations that were created before this rule, and on any
row whose identity ID has no identity record. It adds a Slack identity when
Junior did not have one for the creator.

The collection filters, sorts, and pages all accessible Automations in SQL.
Counts use the same access rules. Public access and Destination labels come
from the Destination directory. Missing or private entries do not grant access.

Scheduled automations run through the heartbeat. Event automations run when a
matching event arrives.

## Tools

One set of agent tools manages both kinds. `chat/tools/automations.ts`
registers them, and `chat/automations/tools/` owns them:

- `createAutomation` takes a `trigger`. Its `type` is `schedule` or `event`.
- `searchAutomations` uses the dashboard Automations search. An optional
  `type` limits it to one kind.
- `updateAutomation` edits, pauses, resumes, or moves one Automation. A
  replacement trigger must have the same type. Only a Scheduled automation can
  move.
- `deleteAutomation` deletes one Automation.
- `runAutomationNow` queues a Scheduled automation. It rejects an Event
  automation, because only a matching event starts one.

`automationIdForToolCall` keeps the ID that each kind had before the tools
merged, so a replayed create call finds the Automation that it created.

## Management access

One rule decides who can read and manage an Automation, on the dashboard and
in the agent tools. `resolveViewerTaskCandidate` in `read.ts` applies it to one
Automation, and `viewerAutomationCollection` in `collection.ts` applies it in
SQL. Keep the two aligned. `tool-access.ts` builds the tool caller, its
viewer, and the tool error text.

A person can read, edit, pause, resume, and delete an Automation when one of
these is true:

- they created it;
- its Destination is a public channel in one of their linked Slack workspaces;
- they ask from a Conversation whose Location is the channel or DM where it
  delivers.

Other people get not found. So private channel and DM Automations stay with
their creator and the people in that conversation.

The tools work in any Turn that a person started, also in dashboard
Conversations. A Turn that no person started, such as an Automation run or an
Event, cannot use them. The tool viewer has the person's stored identities and
the account of their Actor, so a missing identity lookup does not make the
creator a non-creator. A Conversation with no Location can search and manage
Automations, but it cannot create or move one, because it has no Destination.

Some rules stay with the creator (`edit-rules.ts`):

- Only the creator can enable creator credential use, change outcomes, or move
  the Destination.
- When a non-creator changes the instruction, Schedule, or event selector, the
  Automation switches to system credentials.
- A non-creator cannot resume or run now an Automation that still uses creator
  credentials (`requireCredentialStart`). They can switch it to system
  credentials first. Pause and delete do not start work, so anyone with access
  can use them.

These rules make sure that the creator's credentials run only work that the
creator approved and started.

Deleted automations keep their execution history and title. They do not match
new events or schedules.

An automation title is stored in the SQL `title` column. It is not part of the
JSON `record`. The API uses the first line of the instruction when a title
is missing. Instruction edits keep the stored title. A title changes only when
an edit supplies a replacement.

## Runs

An Automation run is one dispatch of an Automation. Each run is one row in
`junior_automation_runs`.

- The heartbeat claims a Scheduled automation run as `pending`. The run becomes
  `running` when it is dispatched. Its id is `<automation id>:<scheduled time>`.
- Ingest dispatches an event automation run as `running`. Its id is the
  dispatch id.
- Dispatch sets `conversation_id` when the dispatch Conversation exists. A
  later write of the same run fills a missing link. A skipped run, or a run
  that fails before dispatch, has no Conversation.
- Dispatch sets `automation_version` to the newest version whose definition
  is the same as the dispatched definition. Later writes keep it. It is null
  when the run was not dispatched, and when no version matches. This shows
  which instruction a run used, and who saved it, after later edits.
- The heartbeat settles running runs of both kinds from their dispatch record,
  also when the Automation was deleted during the run. A run whose dispatch
  record is gone becomes `failed`.
- An execution is a run with the outcome `blocked`, `completed`, or `failed`.
  Execution lists, stats, and the last run status read only executions.
- The Conversation title fallback and the run card join on `conversation_id`.

## Web edits

`GET /api/automations/:id/edit` returns exact values and an opaque
revision. It does not depend on a list page. Scheduled edits return the stored
Schedule and next occurrence. Event edits return the full selector, including
match conditions. Both include ordered outcomes and credential mode.

`PATCH /api/automations/:id` requires that revision and the stored `kind`.
It accepts only changed fields. Omitted fields stay unchanged. A replacement
Schedule uses `ScheduleIntent`, the same input as the agent tools. The API does
not accept lifecycle or creator changes. It does not dispatch work or restart
a completed Automation.

The shared edit functions own Schedule compilation, plugin event validation,
creator credential rules, and outcome resolution. A new outcome can target only
the current Destination or the original creator. An exact stored outcome can
be kept or reordered, even if the editor cannot create that Destination.
Unchanged event selectors can keep unavailable events and match fields.
Replacement selectors must pass the current plugin catalog rules.

The revision hashes the decoded stored values, including title and lifecycle.
Scheduled saves compare it under the task lock. Event saves compare it under a
SQL row lock. Tool edits use the same check. A scheduler state change can also
invalidate an open edit. The API returns 409 for a stale edit, 400 with field
paths for input errors, and 404 for an Automation the user cannot read. The
editor must keep unsaved input when a save fails.

A public reader edits with the same rules as a non-creator in the tools. They
cannot enable creator credential use or change outcomes. A change to the
instruction or event selector switches creator credential use to system
credentials. The edit read returns `ownedByViewer` so the editor can show
these rules before a save.

An Automation runs later without the request that created it. So the agent
tools tell the agent to write exact targets, such as a channel mention or a
link. The agent calls the creator "the Automation creator". It names every
other person with their Slack mention, also a requester who did not create the
Automation. Each run puts the creator mention in the `Created by:` task input
line. That line also says that "me" and "my" mean the creator. People can
write these words in the dashboard editor.

The agent tools that create or update an Automation reject an instruction that
names the requester by display name without their Slack mention. A name does
not notify the person.

## Versions

An Automation version is one saved definition. The definition is the title,
instruction, Schedule or event selector, Destination, outcomes, and credential
mode. Status and run times are not part of it. Pause, resume, delete, and
run-now do not make a version.

The save writes the version in the same transaction and lock as the
Automation. A save that does not change the definition does not make a
version. A new Automation gets version 1 from its creator. Tool and dashboard edits
record the requester.

Migration 0046 saves the current definition of each live Automation as
version 1, with no editor.

`GET /api/automations/:id/versions` returns the newest 100 versions. It
uses the same read access as executions. `activeVersion` is the newest version
that matches the current definition.

`POST /api/automations/:id/versions/:version/activate` makes a version
active. It needs the edit read revision. It saves that definition as a new
version, so history is never rewritten. It uses the edit access and edit rules,
so a public reader cannot use it to enable creator credentials or change
outcomes. The creator can restore messages to the Destination or to the
creator DM. A version with another Destination or a one-time Schedule cannot
be made active. A one-time version does not keep its run time.

## Pause and attention

Pause and resume are separate from form saves. Both check the read revision
under the same lock as edits. See Management access for who can use them. They keep credentials and history
and cannot restart completed work.

`scope=attention` filters the full collection before counting and paging. It
includes blocked Automations, unavailable event triggers, and failed or blocked
last runs. It excludes paused and completed work. A failed run does not mean
future runs are disabled.
