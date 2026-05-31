## ADDED Requirements

### Requirement: Scheduled task data model

Junior SHALL store scheduled work as a normalized task contract, not as a stored Slack message or raw user utterance.

#### Scenario: Task is created

- **WHEN** a scheduled task is created
- **THEN** it SHALL store task text, creator metadata, destination, schedule, timezone, status, next run timestamp when active, optional recurrence, optional original request, execution actor, conversation access, and optional credential subject

#### Scenario: Creator metadata exists

- **WHEN** creator metadata is stored
- **THEN** it SHALL be audit/notification metadata only and SHALL NOT become the execution actor or an ownership gate

#### Scenario: Original request exists

- **WHEN** the original user utterance is retained
- **THEN** Junior SHALL NOT treat it as the sole execution input

#### Scenario: Task is deleted

- **WHEN** a task is deleted
- **THEN** it SHALL be removed from active/list indexes and excluded from list output

### Requirement: Scheduled run data model

Junior SHALL represent each due occurrence as a scheduled run.

#### Scenario: Run is claimed

- **WHEN** a task occurrence is claimed
- **THEN** Junior SHALL create a run with id `task_id:scheduled_for_ms`, idempotency key, task id/version, scheduled timestamp, attempt, claim timestamp, and status `pending`

#### Scenario: Run is dispatched

- **WHEN** core dispatch creation succeeds for a run
- **THEN** Junior SHALL store the dispatch id, started timestamp, and status `running`

#### Scenario: Run reaches terminal state

- **WHEN** dispatch completes, fails, blocks, or a run is skipped
- **THEN** Junior SHALL store terminal status, completion timestamp, and result or error metadata when available

### Requirement: Calendar schedule model

Junior SHALL resolve all scheduled tasks to exact timestamps before storage.

#### Scenario: Tool receives exact timestamp

- **WHEN** scheduler tools receive `next_run_at`
- **THEN** it SHALL be a valid ISO timestamp with timezone offset or `Z`

#### Scenario: Tool receives natural-language time

- **WHEN** a scheduler tool receives natural-language or locale-specific time as `next_run_at`
- **THEN** it SHALL reject the input with a model-visible tool input error

#### Scenario: Timezone is omitted

- **WHEN** task creation omits timezone
- **THEN** Junior SHALL default to `JUNIOR_TIMEZONE` or `America/Los_Angeles`

#### Scenario: Timezone is invalid

- **WHEN** timezone is not a valid IANA timezone
- **THEN** scheduler tool execution SHALL fail before storing a task

### Requirement: Calendar recurrence model

Junior SHALL support a small calendar recurrence model anchored to local time.

#### Scenario: Recurrence is omitted

- **WHEN** task creation omits recurrence
- **THEN** Junior SHALL store a one-off task

#### Scenario: Recurrence is daily weekly monthly or yearly

- **WHEN** recurrence is `daily`, `weekly`, `monthly`, or `yearly`
- **THEN** Junior SHALL derive a recurrence rule from the exact first run timestamp and timezone

#### Scenario: Weekly recurrence has no explicit weekdays

- **WHEN** weekly recurrence is created without stored weekdays
- **THEN** Junior SHALL use the first run's local weekday

#### Scenario: Monthly or yearly recurrence hits unsupported date

- **WHEN** the next calendar month or year lacks the stored day-of-month
- **THEN** Junior SHALL skip that unsupported date rather than moving to another day

#### Scenario: Recurrence is sub-daily

- **WHEN** recurrence input is not one of the supported calendar frequencies
- **THEN** Junior SHALL reject it because recurring tasks can run at most once per day

#### Scenario: Recurrence is converted to one-off

- **WHEN** update input sets recurrence to `null`
- **THEN** Junior SHALL convert the task to one-off

### Requirement: Slack schedule tool availability

Junior SHALL expose scheduler management tools only when trusted plugin tool context has complete Slack turn context.

#### Scenario: Slack context is complete

- **WHEN** channel id, team id, and requester id are available
- **THEN** the scheduler trusted plugin MAY register schedule management tools

#### Scenario: Slack context lacks requester

- **WHEN** no requester id is available
- **THEN** scheduler tools SHALL NOT be registered

#### Scenario: Slack context lacks destination

- **WHEN** no active Slack destination is available
- **THEN** scheduler tools SHALL NOT be registered or SHALL fail before mutation

### Requirement: Slack task creation

Junior SHALL create scheduled tasks for the active Slack destination only.

#### Scenario: Clear one-off request is created

- **WHEN** the model calls the create tool with task text, schedule description, exact next run timestamp, and no recurrence
- **THEN** Junior SHALL store an active one-off task

#### Scenario: Clear recurring request is created

- **WHEN** the model calls the create tool with supported recurrence and exact next run timestamp
- **THEN** Junior SHALL store an active recurring task

#### Scenario: Active destination is a thread

- **WHEN** scheduler tools receive a thread timestamp
- **THEN** the stored destination SHALL still be the parent Slack conversation, not the existing thread

#### Scenario: Destination is another channel or user

- **WHEN** a user asks to schedule work for another channel or another user's DM
- **THEN** scheduler tools SHALL NOT store that other destination; destination comes from the active Slack context

### Requirement: Conversation access and credential subject

Junior SHALL distinguish destination audience from credential delegation.

#### Scenario: Destination is a DM

- **WHEN** a task is created in a Slack DM
- **THEN** Junior SHALL store private direct conversation access and MAY store an explicit user credential subject for the requester

#### Scenario: Destination is private group

- **WHEN** a task is created in a private group conversation
- **THEN** Junior SHALL NOT store a user credential subject

#### Scenario: Destination is public or unknown channel

- **WHEN** a task is created in a public or unknown-visibility channel
- **THEN** Junior SHALL NOT store a user credential subject

#### Scenario: Scheduled run dispatches credential subject

- **WHEN** a task stores an explicit credential subject
- **THEN** the scheduler SHALL pass that credential subject to core dispatch without making the creator the runtime requester

### Requirement: Destination-scoped task management

Junior SHALL let active-destination participants manage tasks for that same Slack destination.

#### Scenario: User lists tasks

- **WHEN** a user lists scheduled tasks in a Slack destination
- **THEN** Junior SHALL return only non-deleted tasks for that destination and SHALL NOT reveal tasks from other destinations in the workspace

#### Scenario: User edits task from same destination

- **WHEN** any requester in the same active destination edits, pauses, resumes, deletes, or run-now queues a task
- **THEN** Junior SHALL allow the operation if the task id belongs to that destination

#### Scenario: User edits task from different destination

- **WHEN** a requester tries to manage a task from another destination
- **THEN** Junior SHALL reject the operation

#### Scenario: Task is resumed

- **WHEN** a blocked or paused task is resumed to active
- **THEN** Junior SHALL clear stale block reasons when the task has a next run timestamp

### Requirement: Run-now behavior

Junior SHALL queue an active task for immediate execution without changing its stored calendar cadence.

#### Scenario: Active task is run now

- **WHEN** `run now` is requested for an active task
- **THEN** Junior SHALL store a separate immediate-run timestamp and preserve `nextRunAtMs`

#### Scenario: Paused task is run now

- **WHEN** `run now` is requested for a paused, blocked, deleted, or non-active task
- **THEN** Junior SHALL reject it and SHALL NOT implicitly resume the task

#### Scenario: Run-now and scheduled run are both due

- **WHEN** immediate-run timestamp and ordinary `nextRunAtMs` are both due
- **THEN** Junior SHALL claim the immediate run first

### Requirement: Scheduler storage and indexes

Junior SHALL persist scheduler state through the trusted plugin state namespace.

#### Scenario: Task is saved

- **WHEN** a non-deleted task is saved
- **THEN** Junior SHALL persist it and include it in global and team task indexes

#### Scenario: Task changes teams

- **WHEN** a task destination team changes
- **THEN** Junior SHALL update team indexes so the task appears only in the current team index

#### Scenario: Deleted task is saved

- **WHEN** a deleted task is saved
- **THEN** Junior SHALL remove it from global and team task indexes

#### Scenario: Active run marker exists

- **WHEN** a task has a non-stale active run marker
- **THEN** Junior SHALL NOT claim another run for the same task

### Requirement: Run idempotency

Junior SHALL suppress duplicate scheduled run dispatch for the same task occurrence.

#### Scenario: Duplicate due claim occurs

- **WHEN** two heartbeat passes attempt to claim the same due task occurrence
- **THEN** only one claim SHALL create a pending run

#### Scenario: Pending claim is stale

- **WHEN** a pending claim has not been dispatched within the stale pending window
- **THEN** a later heartbeat MAY clear and reclaim it

#### Scenario: Run has active marker

- **WHEN** a task already has an unfinished active run
- **THEN** later due occurrences for the same task SHALL NOT dispatch until the active run is cleared or stale

### Requirement: Missed run policy

Junior SHALL skip stale scheduled occurrences instead of executing arbitrarily old work.

#### Scenario: One-off occurrence is stale

- **WHEN** a one-off occurrence is more than the missed-run age limit older than scheduler time
- **THEN** Junior SHALL store a skipped run, avoid dispatch, pause the task, and clear `nextRunAtMs`

#### Scenario: Recurring occurrence is stale

- **WHEN** a recurring occurrence is stale
- **THEN** Junior SHALL store a skipped run, avoid dispatch, and advance directly to the next future recurrence when one exists

#### Scenario: Run-now request is stale

- **WHEN** a run-now timestamp is stale
- **THEN** Junior SHALL clear that immediate run without shifting the ordinary schedule

#### Scenario: Equivalent duplicate stale task exists

- **WHEN** a newer active stale task has the same destination, schedule, and normalized task text as an older active task
- **THEN** Junior MAY skip and pause the duplicate while leaving the older canonical task active

### Requirement: Scheduler heartbeat flow

Junior SHALL use trusted plugin heartbeat to reconcile and dispatch scheduled runs.

#### Scenario: Incomplete dispatched run exists

- **WHEN** scheduler heartbeat finds an incomplete run with dispatch id
- **THEN** it SHALL call `ctx.agent.get(dispatchId)` and apply completed, blocked, or failed dispatch results to the run and task

#### Scenario: Dispatch record is missing

- **WHEN** `ctx.agent.get(dispatchId)` returns `undefined` for an incomplete run
- **THEN** scheduler SHALL eventually mark the run failed or otherwise reconcile according to scheduler policy

#### Scenario: Due run is claimable

- **WHEN** scheduler heartbeat claims a due run
- **THEN** it SHALL build a scheduled-run prompt and call `ctx.agent.dispatch` with idempotency key, destination, prompt input, optional credential subject, and task/run metadata

#### Scenario: Prompt cannot be built

- **WHEN** the scheduled-run prompt cannot be built
- **THEN** scheduler SHALL mark the run and task blocked

#### Scenario: Dispatch cannot be created

- **WHEN** core dispatch creation fails for a claimed run
- **THEN** scheduler SHALL mark the run and task blocked

#### Scenario: Heartbeat has more due work than limit

- **WHEN** more due work exists than the scheduler heartbeat limit
- **THEN** scheduler SHALL process bounded work and leave the rest for later heartbeats

### Requirement: Scheduled-run prompt framing

Junior SHALL compile scheduled task runs into marker-delimited prompts before dispatch.

#### Scenario: Prompt is built

- **WHEN** a scheduled run prompt is built
- **THEN** it SHALL include marker-delimited scheduled-task, run-context, execution-rules, and highest-priority current-instruction sections

#### Scenario: Task text is empty

- **WHEN** task text is missing or blank
- **THEN** prompt building SHALL fail

#### Scenario: Prompt includes actor facts

- **WHEN** prompt includes creator metadata
- **THEN** it SHALL also state that execution uses the scheduled-task system actor and creator metadata is audit context only

#### Scenario: Prompt asks for execution

- **WHEN** prompt is sent to the agent
- **THEN** it SHALL instruct the agent to execute the stored task now, not create or edit a schedule

### Requirement: Scheduler actor and auth model

Junior SHALL execute scheduled runs as system actor work, not as the creator's active user turn.

#### Scenario: Scheduled run executes

- **WHEN** scheduler dispatches a run
- **THEN** core dispatch SHALL run with a system actor and no Slack requester

#### Scenario: Creator has OAuth tokens

- **WHEN** the creator has user OAuth tokens but no explicit credential subject is stored
- **THEN** scheduled execution SHALL NOT implicitly use those tokens

#### Scenario: Auth is missing

- **WHEN** scheduled execution requires credentials or authorization unavailable to the system actor or explicit credential subject
- **THEN** the run SHALL become blocked rather than starting an interactive public authorization flow

### Requirement: Scheduler Slack UX and eval coverage

Junior SHALL verify model-dependent scheduler behavior with evals.

#### Scenario: Simple one-off reminder is clear

- **WHEN** a user asks for a simple one-off reminder in the active Slack context
- **THEN** the agent SHOULD create it immediately without asking for confirmation

#### Scenario: Clear recurring work is requested

- **WHEN** a user clearly asks to schedule recurring work
- **THEN** the agent SHOULD create the task immediately, set recurrence correctly, and confirm the schedule

#### Scenario: Scheduling request is ambiguous

- **WHEN** task text, schedule, or active destination is ambiguous
- **THEN** the agent SHOULD ask for clarification or confirmation before creating a task

#### Scenario: Scheduled execution prompt is evaluated

- **WHEN** a scheduled task run enters the agent
- **THEN** eval coverage SHOULD verify the model executes the task instead of modifying the schedule

### Requirement: Scheduler verification taxonomy

Junior SHALL verify scheduler behavior at the appropriate layer.

#### Scenario: Tool/store/calendar logic changes

- **WHEN** schedule tools, store claims, recurrence helpers, run-now, missed-run policy, or prompt helper behavior changes
- **THEN** unit or integration tests SHALL cover the deterministic behavior

#### Scenario: Heartbeat dispatch wiring changes

- **WHEN** scheduler heartbeat dispatch/reconcile behavior changes
- **THEN** integration tests SHALL cover trusted plugin heartbeat and dispatch state transitions

#### Scenario: Natural-language scheduling changes

- **WHEN** schedule extraction, confirmation choice, or scheduled-run execution framing changes
- **THEN** evals SHALL cover the model-dependent behavior
