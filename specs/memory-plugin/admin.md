# Memory Plugin Admin

## Metadata

- Created: 2026-06-13
- Last Edited: 2026-06-28

## Purpose

Define operator/admin capabilities for inspecting and repairing memory state
outside model-visible tools.

## Scope

- Future plugin-contributed CLI command shape for memory.
- Admin operations for inspection, removal, repair, and embedding maintenance.
- Security and redaction rules for operator output.

## Non-Goals

- Requiring a memory admin CLI for V1.
- Letting the model invoke admin commands.
- Defining a dashboard UI for memory administration.
- Defining account deletion, legal export, or retention workflows.

## Command Shape

The memory plugin should reserve a future plugin CLI command:

```txt
junior memory ...
```

This command is registered through the plugin CLI surface described in
[`../plugin-cli.md`](../plugin-cli.md). It is not a model-visible tool and is
not available inside sandbox command execution.

Possible subcommands:

- `junior memory stats`
- `junior memory list`
- `junior memory show <id>`
- `junior memory remove <id>`
- `junior memory repair`
- `junior memory rebuild-embeddings`

The exact subcommand set can be narrowed during implementation. The broad need
is an operator surface for visibility debugging and repair that does not expand
the model tool surface.

## Admin Context

The command must run with a host/admin context, not as an inferred Slack or
local chat actor.

Commands that operate on user-visible memory must require explicit selectors
such as actor identity, conversation identity, source platform, or memory
id. Selectors are resolved through the same storage visibility model used by
runtime code; display names and labels are not authorities.

## Operations

### stats

Reports aggregate counts by scope type, subject type, memory kind, archive
state, embedding status, repair status, and policy-hidden status.

Default output must not include raw memory content.

### list

Lists memories for an explicit scope or query.

Default output should include ids, scope type, subject type, memory kind,
timestamps, archive state, and short redacted previews. Full content requires
an explicit flag such as `--show-content`.

### show

Shows one memory by id when the operator explicitly requests it.

The output may include content, source attribution, lifecycle state, embedding
status, and bounded metadata. It must not include raw transcript payloads,
provider credentials, tokens, or raw extraction prompts.

### remove

Archives one memory by id with an admin archive reason.

The command must not physically delete rows in V1. Account deletion and legal
retention flows need a separate retention/export spec.

### repair

Runs bounded consistency repair:

- archive expired memories
- repair malformed lifecycle markers when deterministic
- identify missing or stale embedding rows
- enqueue embedding repair tasks

Repair should report counts and task ids, not raw content.

Repair must not silently make policy-hidden memories visible. If policy changes
make stored rows disallowed, repair should report counts and allow a future
operator workflow to archive them.

### rebuild-embeddings

Enqueues or runs bounded embedding rebuild work for selected memories.

The command should prefer background task enqueueing for large work. If it runs
inline locally, it must use the same embedding provider boundary and dimension
checks as runtime storage.

## Security Rules

1. Admin commands are privileged host operations, not user-facing chat actions.
2. Default output must avoid raw private memory content.
3. Full-content output requires an explicit operator action.
4. Commands must not reveal secrets even with `--show-content`; secret
   detection failures found during admin inspection should be reported as
   repair findings and handled through a future deletion/retention workflow.
5. Commands must not accept model-style arbitrary actor, team, channel, thread,
   or conversation ids as implicit authority. Selectors identify what to inspect;
   deployment/operator authorization is a separate boundary.
6. Logs and spans for admin commands follow [`./security.md`](./security.md).

## Related Specs

- `./index.md`
- `./policy.md`
- `./storage.md`
- `./security.md`
- `./tools.md`
- `./verification.md`
- `../plugin-cli.md`
