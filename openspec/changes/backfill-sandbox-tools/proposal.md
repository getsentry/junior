# Backfill `sandbox-tools`

## Why

Junior's sandbox-backed tools provide the agent's file, shell, search, edit, and attachment surface. These tools rely on Vercel Sandbox lifecycle behavior, workspace path constraints, bounded outputs, exact edit semantics, and generated-file handoff to Slack replies. The shared tool wrapper is now captured by `tool-execution`; this capability needs to capture the concrete sandbox tool contracts.

## What Changes

- Add an OpenSpec capability for `sandbox-tools`.
- Specify sandbox lifecycle assumptions used by the tools: named active sandbox reuse, snapshot-backed fresh starts, keepalive, and no implicit durable workspace recovery after stop.
- Specify bash, read, write, edit, list, find, grep, and attach-file behavior.
- Specify workspace path confinement, bounded output, missing-path behavior, exact edit validation, generated-file attachment handoff, and failure boundaries.
- Record current tests and gaps around sandbox persistence, command interruption, and generated file attachments.

## Impact

- Affected specs:
  - `tool-execution`
  - `security-policy`
  - `credential-injection`
  - `sandbox-snapshots`
  - `slack-agent-delivery`
  - `reply-planning`
  - `testing`
- Affected code evidence:
  - `packages/junior/src/chat/sandbox/session.ts`
  - `packages/junior/src/chat/sandbox/sandbox.ts`
  - `packages/junior/src/chat/sandbox/workspace.ts`
  - `packages/junior/src/chat/tools/sandbox/*`
  - `packages/junior/src/chat/tools/execution/build-sandbox-input.ts`
- Affected verification:
  - Unit tests for sandbox file/search/edit helpers and adapter behavior.
  - Runtime/unit tests for lazy sandbox acquisition and generated-file handoff.
  - Integration tests for sandbox egress and external sandbox behavior when credentials/network are available.
