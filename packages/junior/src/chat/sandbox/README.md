# Sandbox Runtime

The sandbox module creates isolated workspaces, installs declared runtime
dependencies, synchronizes skills, and proxies credential-capable network
traffic through verified host egress.

## Lifecycle

- Sandboxes are ephemeral execution environments associated with a durable
  conversation or run.
- Runtime state persists only an opaque `SandboxRef` (`id`, dependency profile
  hash, and optional workspace id). The provider adapter maps that reference to
  Vercel's named sandbox API; callers do not depend on provider names or VM
  session ids.
- Each agent run creates lazy sandbox access from the persisted reference.
  `workspace` serves non-sandbox tools and generated artifacts, while `tools`
  serves the Pi sandbox tool adapter. The live provider session stays private
  to this module.
- An unavailable session fails the current operation without replay, retains
  its sandbox identifier, and reacquires a session only on a later operation.
- New or replacement references are persisted before session preparation can
  perform further asynchronous work. Reacquiring a VM session for the same
  reference does not rewrite durable state.
- Agent runs do not stop sandboxes when they finish. Explicit temporary owners,
  such as dependency snapshot creation, own their own stop lifecycle.
- Do not treat the sandbox filesystem as product storage.
- Commands are non-interactive and bounded by runtime deadlines.
- Generated files become shareable only after artifact validation and
  destination-aware delivery planning.

## Repository Instructions

- Bash `cwd` applies only to that command. It does not select AGENTS scope, and
  Junior does not parse shell text or process-local `cd` state.
- Exactly one direct-child Git worktree may be selected automatically. Zero or
  multiple worktrees leave repository instructions unset.
- Automatic selection currently uses the worktree root, so Junior reads only
  its root `AGENTS.md`. Changed instructions are added as runtime-owned user
  context; sandbox tool results never contain them.
- Only `AGENTS.md` is supported. Overrides, Git hooks, recursive repository
  discovery, and filesystem watchers are intentionally out of scope.

## Dependency Snapshots

- The declared plugin/runtime dependency profile is the source of truth.
- A deterministic profile hash selects a reusable snapshot.
- Snapshot creation installs only the declared dependencies and post-install
  steps for that profile.
- A workspace profile selects a snapshot that starts from the resolved base
  dependency snapshot, then runs repository and setup preparation.
- A workspace snapshot cache key includes the base snapshot id. Rebuilding the
  base therefore rebuilds each workspace snapshot on its next use.
- Missing or invalid snapshots rebuild through the owning snapshot path;
  callers do not mutate a cached snapshot in place.
- Snapshot state never contains real provider credentials.
- The global baseline installs Docker and Compose clients plus
  `junior-ensure-docker`. Sandbox prepare starts `dockerd` so nested
  `docker compose` works after snapshot boot; the daemon is not part of the
  snapshot process tree.

## Network And Credentials

All credential-capable provider access follows
`../../../../../policies/security.md`. The verified egress implementation lives
under `egress/`; `snapshot/resolve.ts` owns snapshot acquisition.
