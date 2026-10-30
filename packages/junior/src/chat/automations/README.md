# Automations

This module projects scheduled and event automations for signed-in users. It
includes automations that the user owns and automations in public destinations
in the user's linked Slack workspaces.

Each Automation stores `creator_identity_id`, the Junior identity that created
it. A foreign key to `junior_identities` makes sure that identity exists. The
user owns an Automation when one of their identities has that ID. This
rule is the same for both kinds. The Slack create tools refuse to save an
Automation when the requester has no stored identity. Migration 0058 sets the
identity on event automations that were created before this rule, and on any
row whose identity ID has no identity record. It adds a Slack identity when
Junior did not have one for the creator.

The collection filters, sorts, and pages all accessible Automations in SQL.
Counts use the same access rules. Public access and Destination labels come
from the Destination directory. Missing or private entries do not grant access.

Scheduled automations run through the heartbeat. Event automations run when a
matching event arrives. The dashboard can edit Automations that the user owns
or can read through a public Destination. Pause, resume, and delete stay
creator-only on the web.

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
Schedule uses `ScheduleIntent`, the same input as the Slack tools. The API does
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
SQL row lock. Slack edits use the same check. A scheduler state change can also
invalidate an open edit. The API returns 409 for a stale edit, 400 with field
paths for input errors, and 404 for an Automation the user cannot read. The
editor must keep unsaved input when a save fails.

A public reader edits with the same rules as a non-creator in Slack. They
cannot enable creator credential use or change outcomes. A change to the
instruction or event selector switches creator credential use to system
credentials. The edit read returns `ownedByViewer` so the editor can show
these rules before a save.

An Automation runs later without the request that created it. The instruction
keeps "me" and "my" for the creator. Each run reads the creator identity and
renders its mention for the Destination in the `Created by:` task input line.
The `createdBy` copy does not decide this. Other people need an exact mention
in the instruction, because the request is gone at run time. The agent tools
that create or update an Automation reject an instruction that names the
requester by display name without their Slack mention. A name does not notify
the person.

## Versions

An Automation version is one saved definition. The definition is the title,
instruction, Schedule or event selector, Destination, outcomes, and credential
mode. Status and run times are not part of it. Pause, resume, delete, and
run-now do not make a version.

The save writes the version in the same transaction and lock as the
Automation. A save that does not change the definition does not make a
version. A new Automation gets version 1 from its creator. Slack and web edits
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

Pause and resume are creator-only actions, separate from form saves. Both check
the read revision under the same lock as edits. They keep credentials and history
and cannot restart completed work.

`scope=attention` filters the full collection before counting and paging. It
includes blocked Automations, unavailable event triggers, and failed or blocked
last runs. It excludes paused and completed work. A failed run does not mean
future runs are disabled.
