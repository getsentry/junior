# Chat Runtime

`packages/junior/src/chat` turns source events into durable agent runs and
delivers completed assistant messages. Code, runtime schemas, and tests are authoritative;
this file records ownership boundaries that are difficult to infer from one
file.

## Flow

1. `ingress/` parses, classifies, and normalizes source events.
2. Mailbox-backed sources append work and send a queue nudge through
   `task-execution/`. `agent-invocations/` uses the same mailbox for
   destinationless child work.
3. A worker acquires the conversation lease, drains pending input, and restores
   persisted conversation state.
4. `runtime/` prepares and orchestrates the run; `agent/` owns Pi execution.
5. Tools, plugins, credentials, sandbox, and MCP operate within harness-owned
   actor and destination context.
6. `agent/` emits every completed, tool-free visible assistant message through
   one awaited delivery port with the completed Pi message that produced it;
   provider adapters deliver, then commit that agent message before the visible
   reply in one transaction. Tool-bearing assistant text remains internal to
   the agent loop.
7. The completed run result supplies diagnostics and artifacts; successful
   delivery or intentional no-reply completion commits the durable turn outcome.

The local CLI uses `local/runner.ts` directly rather than pretending to be a
mailbox-backed provider. API-authored root turns and dashboard continues of
existing conversations use the shared mailbox and worker through `api-turns/`
with `publishExternally: false`. Continues keep the conversation destination
(including Slack) for location context and never copy replies to the provider.

## Ownership

- `app/`: composition root only.
- `ingress/`: source parsing, classification, and routing.
- `task-execution/`: mailbox, queue, lease, checkpoint, worker, and recovery.
- `runtime/`: turn orchestration and provider-neutral delivery callbacks.
- `api-turns/`: mailbox enqueue and worker consumer for dashboard/API turns
  that stay in the conversation log (`publishExternally: false`), including
  continues of Slack-rooted conversations by verified participants.
- `agent-dispatch/`: durable task and plugin dispatch authority, mailbox
  adaptation, and plugin-facing outcome projection.
- `agent-invocations/`: durable parent/child bindings, delegated work, and
  internal terminal results.
- `event-tasks/`: durable instructions matched to normalized resource events.
- `scheduled-tasks/`: durable scheduled instructions, authoring tools, and
  heartbeat dispatch.
- `tasks/`: signed-in user projection across scheduled and event tasks.
- `agent/` and `pi/`: model execution and Pi state conversion.
- `services/`: consumer-owned domain decisions.
- `attachments/`: provider-neutral attachment metadata, object storage, and garbage collection.
- `artifacts/`: content-addressed public artifacts, SQL metadata, and their unauthenticated read path.
- `state/` and `conversations/`: persistence by concern.
- `slack/` and `local/`: platform adapters.
- `plugins/`, `credentials/`, `sandbox/`, and `mcp/`: external capability
  boundaries.
- `tool-support/action-review.ts`: effective approval modes, authoritative
  action proposals, deterministic context checks, and the execution gate.
- `services/guardian-action-policy.ts` and `guardian-action-review.ts`: the
  Codex-derived policy and structured model reviewer for actions that enter
  review.

Provider modules must not import runtime orchestration. Runtime and service
modules depend on small injected ports rather than provider implementations or
the production singleton.

## Vocabulary

- **Conversation**: durable identity shared by messages and agent state.
- **Turn**: one response-producing execution for accumulated user input.
- **Run**: one bounded attempt to advance a turn; a turn may span resumed runs.
- **Agent history item**: one persisted replayable model input or output.
- **History replacement**: explicit agent-history reset after compaction or handoff.
- **Reply**: one destination-visible assistant message owned by delivery code.
- **Actor**: human or system principal associated with current work.
- **Credential subject**: principal whose provider authority may be used.
- **Destination**: platform location where output is delivered.
- **publishExternally**: per-turn side effect. When true, also publish assistant
  output to the conversation destination. The conversation log always stores the
  turn. Missing or false means conversation-only.

Attribution does not grant authority. `run.actors` records participating actors;
credential issuance still requires the current actor or an explicit delegated
subject. Scheduled-task creator identity may authorize task-scoped credential
delegation without becoming the execution actor or a general task owner.

## Invariants

- Each completed tool-free visible assistant message is delivered before the
  run advances; assistant delivery settles before the turn is finalized.
- Empty assistant output after a history replacement is retried once from the
  last user or tool-result boundary. A second empty response ends as an
  execution failure.
- Retry continuations retain an exact transcript prefix. Usage from discarded
  assistant tails is carried forward separately so retained messages are
  counted once.
- Repo-owned tools declare `readOnlyHint`, `destructiveHint`, `openWorldHint`,
  and `idempotentHint`. External plugin and MCP tools with missing hints are
  logged and enter action review conservatively.
- Tool-bearing assistant text stays in agent history but is not destination
  output; explicit progress uses the runtime status surface.
- Tool failures remain internal agent-loop data unless the final result exposes
  an appropriate diagnostic.
- Durable state is committed before acknowledging queue work or yielding.
- Conversation events emitted by plugin operations preserve conversation
  activity, archive, and transcript-retention state.
- Archive stays set through system noise (resource events, turn lifecycle,
  compaction/handoff). Only a human user instruction or human visible user
  message restores an archived conversation to the feed.
- Model input stays below the configured bot context cap and the active model's
  advertised window. The agent checks before its first provider request and
  after each tool batch; an in-turn compaction commits its history replacement
  and resumable boundary before execution continues. A handoff changes the
  active model and history, then passes through the same capacity check rather
  than bypassing it. Compaction events retain the active model plus privacy-safe
  capacity and replacement metrics for reporting without exposing the summary
  or replaced history.
- Cooperative yield preserves the exact agent history and occurs only at a user
  or tool-result tail. Unlike timeout or auth recovery, it never rolls history
  back past delivered assistant output.
- Once destination accepts a tool-free assistant reply, the turn is finished for
  that reply. Hard timeout must complete the turn. It must not park a shorter
  history. Soft yield after a pure assistant tail already cannot park; soft yield
  after delivery plus steering may still park so steered work can continue.
- Unexpected failures propagate to the boundary that owns capture and fallback
  delivery.
- Actor, execution destination, conversation, and credential context remain
  explicit across asynchronous boundaries. A destinationless child
  conversation receives its bounded execution destination from its durable
  agent invocation.
- External publish is controlled per turn via `publishExternally`. Slack
  ingress/resume publish unless the flag is explicitly false. Non-Slack,
  destinationless, and dashboard/web work stay conversation-only unless the
  flag is true. Destination presence must not invent publish. A web Source may
  keep a Slack Destination when `publishExternally` is false.
- Host-owned runtime context and the actor's current instruction are separate
  user messages. The context message immediately precedes the instruction,
  remains context-authority on resume, and may be replaced before a later model
  sample without replaying the actor's instruction. Ambient thread history in
  that context message is evidence only; only `<current-instruction>` authorizes
  work.
- Action review sees the validated, hook-adjusted semantic input immediately
  before execution; hook-injected environment values stay execution-only.
  Plugin tools with omitted approval modes use auto policy; core tools must opt
  in explicitly. Every execution attempt that enters review reaches Guardian;
  prior rejections are context rather than binding decisions. Each Guardian
  decision is committed to the conversation event log before the reviewed
  action can continue. `ask` and `deny` become expected tool failures, and three
  consecutive rejections interrupt the execution slice.
- Guardian receives a projection of credential authority, never signed
  credential bindings, plus bounded user, assistant, tool-call, and tool-result
  evidence selected with the Codex Guardian transcript rules. It cannot override
  deterministic context checks, and unavailable review fails closed.

Follow `../../../../policies/context-bound-systems.md`,
`../../../../policies/provider-boundaries.md`, and the feature READMEs in
this directory.
