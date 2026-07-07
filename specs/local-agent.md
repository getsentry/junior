# Local Agent Spec

## Metadata

- Created: 2026-06-10
- Last Edited: 2026-06-11

## Purpose

Define the first local, non-Slack way to run and interact with Junior. This spec
turns local agent testing into a real platform adapter contract instead of a
fake Slack harness.

## Scope

- Local CLI command shape and user flows.
- Local source and destination identities.
- Local conversation ids, state, transcript, and delivery behavior.
- Local runtime wiring into the shared conversation runtime.
- First-pass credential and authorization behavior.
- Verification requirements before implementing or changing local agent
  behavior.

## Non-Goals

- Replacing Slack ingress, Slack delivery, or Slack-specific side-effect tools.
- Implementing Telegram, WhatsApp, Discord, or other network platforms.
- Implementing local OAuth or browser-based authorization flows.
- Supporting local file upload UX as platform attachments in the first pass.
- Defining a terminal UI beyond line-oriented CLI interaction.
- Exposing test-only knobs or fake-agent controls in the product CLI.

## Contracts

### Command Surface

The first local command is `junior chat`.

Supported first-pass forms:

```bash
junior chat
junior chat -p "explain this repository"
```

Rules:

1. `junior chat` starts an interactive terminal loop.
2. `junior chat -p <message>` runs one local user message and exits after
   final delivery.
3. Each CLI invocation creates a fresh local conversation, so repeated local
   runs do not inherit prior local context.
4. Interactive mode preserves multi-turn continuity only inside that running
   process.
5. The local conversation slug must be normalized into a storage-safe
   conversation id before crossing into runtime state.
6. The CLI must load env files through the same env loader as the existing
   command entrypoint before importing chat runtime modules.
7. If no state adapter is explicitly configured for local chat, the command
   must select the memory state adapter before importing chat runtime modules.
   `REDIS_URL` alone must not move local chat onto Redis.

### Interactive Flow

Interactive local chat is a line-oriented loop.

Rules:

1. The prompt reads one user message at a time from stdin.
2. Empty input is ignored.
3. `/exit` and `/quit` end the loop without creating an inbound message.
4. Each non-empty user message is sent to the same process-scoped local
   conversation.
5. The assistant reply may stream to stdout as deltas arrive.
6. The finalized assistant reply is the delivered output recorded in
   conversation state.
7. Tool invocation progress and non-final status may be printed to stderr, but
   they are not persisted as assistant transcript messages.
8. A failed turn must print an explicit error and keep the process exit code
   non-zero for `-p`. Interactive mode may continue after a failed turn
   unless the failure is a local setup error.

### Conversation Identity

Local conversation ids must be storage-safe, stable for one CLI invocation, and
distinct from Slack thread ids.

Rules:

1. Local conversation ids use the prefix `local:`.
2. The normalized shape is `local:<workspace_key>:<conversation_slug>`.
3. `workspace_key` is derived from the current working directory for local
   observability and storage grouping.
4. `conversation_slug` is generated per CLI invocation.
5. Local conversation ids must never use Slack channel ids, thread timestamps,
   team ids, or message timestamps.
6. Local conversation ids are the durable Pi/session history key.

### Source And Destination

Local chat is a first-class local source. The first CLI implementation runs
through a direct local runner rather than the queued inbound-message mailbox.

Rules:

1. Local CLI user input is recorded as a local user turn in the selected local
   conversation.
2. Local invocation context uses `source.platform: "local"`.
3. Local delivery may use `destination.platform: "local"` only at outbound delivery boundaries.
4. Local turn ids are stable within the selected conversation and scoped to the
   local prompt sequence.
5. If a later local or non-Slack platform enters through the durable
   inbound-message mailbox, it must use `source: "local"` or its own
   platform-specific source and stable idempotency ids scoped to that platform.
6. Local inbound metadata may include CLI command mode and local prompt
   sequence. It must not include raw terminal control sequences.
7. Local delivery accepts the finalized reply when stdout/stderr writes have
   completed or when the line-oriented output sink confirms delivery.
8. Local delivery failure is a terminal delivery failure for the local turn.

### Identity And Credentials

Local chat has a local actor identity for runtime/plugin context, but it
does not have a Slack actor or user-bound credential actor.

Rules:

1. Local chat runs as credential actor `{ platform: "system", name: "local-cli" }`.
2. Local chat may populate actor `{ platform: "local", userId: "local-cli" }`.
3. Local chat must not populate Slack actor fields.
4. Local chat must not use Slack private auth, Slack ephemeral messages, or Slack
   OAuth continuation notices.
5. Local chat runs with `authorizationFlowMode: "disabled"` until a local auth
   flow is specified.
6. Provider credentials available through service-principal, install-owned, or
   environment-backed brokers may be used when their broker accepts the
   `local-cli` system actor.
7. Missing user-bound provider credentials must fail with an explicit local
   error. The runtime must not silently fall back to a Slack user, task creator,
   last actor, or `unknown` actor.

### Runtime Wiring

Local chat must exercise the same agent path as other destinations.

Rules:

1. The CLI must call the shared conversation runtime or shared local runner
   boundary. It must not call Slack runtime methods.
2. The CLI must not construct Chat SDK `Thread`, `Message`, or Slack adapter
   wrappers to reach `executeAgentRun`.
3. Runtime context must set `surface: "internal"` until a distinct `local`
   surface is added across reporting and session schemas.
4. Runtime correlation must include `conversationId`, `runId`, and a local
   turn/message id. Slack-only correlation fields must be absent.
5. Local progress callbacks may map assistant status to stderr and text deltas
   to stdout.
6. Local artifact and sandbox updates must persist through the same thread-state
   stores used by the shared runtime.

### Transcript And State

Local chat must preserve conversation continuity across prompts in the same
interactive process. New CLI invocations must start new conversations.

Rules:

1. User messages are appended to visible conversation state before the agent
   turn commits input.
2. Assistant messages are appended only after final local delivery succeeds.
3. Pi messages are restored within the run from the durable agent session log or
   conversation state using the same projection rules as other runtimes.
4. New CLI invocations do not restore prior visible or Pi conversation history.
5. Memory state is acceptable for first-pass local development. When memory
   state is used, history is process-local and the CLI must not imply durable
   persistence.
6. Redis-backed local state may store local runs for diagnostics, but the CLI
   must not automatically resume them.

### Attachments And Files

The first local adapter does not define a platform attachment UX.

Rules:

1. Users may ask the agent to inspect files by path in the message text.
2. The local adapter must not synthesize Slack file attachments.
3. The local adapter has no file-send tool. File-sharing requests must be
   answered as unsupported or with available sandbox paths.
4. A later attachment UX must add explicit local attachment parsing and update
   this spec before implementation.

### User Experience

The local CLI should be predictable and scriptable.

Rules:

1. `-p` writes the assistant final answer to stdout.
2. `-p` writes setup errors, status, and diagnostics to stderr.
3. Interactive mode clearly separates user prompts from assistant output without
   requiring a full-screen terminal UI.
4. The CLI must not print raw prompt context, raw provider credentials, raw OAuth
   URLs, Slack tokens, or serialized private state.
5. The CLI must provide concise usage output for invalid arguments.

## Failure Model

1. Missing model credentials or provider configuration:
   - Print an explicit setup error and exit non-zero for `-p`.
2. Missing user-bound OAuth:
   - Print an explicit local authorization-unavailable error. Do not start Slack
     auth or local browser auth.
3. State adapter setup failure:
   - Print the adapter error and exit non-zero before accepting user input.
4. Agent/provider/tool failure:
   - Deliver the existing agent failure reply when available; otherwise print a
     local error and mark the turn failed.
5. stdout/stderr write failure:
   - Treat as delivery failure and exit non-zero.
6. Unsupported CLI arguments:
   - Print usage and exit non-zero without creating conversation state.

## Observability

Local chat should use existing logging/tracing conventions without creating a
parallel diagnostics system.

Required attributes when available:

- `app.conversation.id`
- `app.conversation.source` = `local`
- `app.source.platform` = `local`
- `app.destination.platform` = `local` when recording delivery
- `app.local.command_mode` = `interactive|prompt`
- `app.actor.type` = `system`
- `app.actor.id` = `local-cli`
- `gen_ai.request.model`
- `gen_ai.provider.name`

Logs and spans must not include raw terminal input beyond the repository's
normal redacted message summaries.

## Verification

Layer choice follows `./testing.md`.

Required checks:

1. Unit: local conversation ids normalize to `local:<workspace_key>:<slug>`
   for generated run slugs.
2. Unit: CLI argument parsing accepts the supported command forms and rejects
   unsupported forms without side effects.
3. Integration: `junior chat -p "hello"` reaches the shared conversation
   runtime with `source.platform: "local"`, actor `local-cli`, and no
   Slack actor.
4. Integration: local CLI does not construct Slack `Thread`, Slack `Message`, or
   Slack adapter wrappers.
5. Integration: two messages in the same interactive process preserve visible
   conversation context, while separate CLI invocations start fresh local
   conversations.
6. Integration: missing user-bound auth produces a local error and does not
   start Slack OAuth or ephemeral-message delivery.
7. Integration: invalid arguments print usage and exit non-zero without creating
   conversation records.
8. Typecheck and targeted tests must pass before enabling the CLI command in the
   packaged binary.

## Related Specs

- `./chat-architecture.md`
- `./task-execution.md`
- `./identity.md`
- `./credential-injection.md`
- `./harness-agent.md`
- `./agent-session-resumability.md`
- `./testing.md`
