# Sandbox Runtime

The sandbox module creates isolated workspaces, installs declared runtime
dependencies, synchronizes skills, and proxies credential-capable network
traffic through verified host egress.

## Lifecycle

- Sandboxes are ephemeral execution environments associated with a durable
  conversation or run.
- Runtime state persists only an opaque `SandboxRef` (`id`, dependency profile
  hash, and optional Workspace id). The provider adapter maps that reference to
  Vercel's named Sandbox API; callers do not depend on provider names or VM
  session ids. A removed Workspace recipe invalidates its stored profile the
  same way any other removed profile input does.
- Each agent run creates lazy sandbox access from the persisted reference.
  `workspace` serves non-sandbox tools and generated artifacts, while `tools`
  serves the Pi sandbox tool adapter. The live provider session stays private
  to this module.
- An unavailable session fails the current operation without replay, retains
  its sandbox identifier, and reacquires a session only on a later operation.
- New base Sandbox references are persisted before session preparation can
  perform further asynchronous work. A Workspace switch persists its prepared
  candidate before replacing the live Sandbox. Reacquiring a VM session for
  the same reference does not rewrite durable state.
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
- A Workspace recipe is part of the profile hash. One build installs runtime
  dependencies, prepares repositories, runs setup, and captures the complete
  snapshot. Operators manage recipes from `/system/workspaces` or
  `/api/workspaces`. After a successful Workspace prepare, Junior records the
  current snapshot id, generation time, build duration, and profile hash on
  the Workspace SQL row for the dashboard.
- Workspace repositories clone to fixed `repos/{name}` paths. Setup scripts
  receive `JUNIOR_WORKSPACE_ROOT` and `JUNIOR_REPOS_ROOT` so they do not depend
  on the provider's absolute Sandbox path.
- Repository preparation uses host egress for provider credentials. Snapshot
  state and Sandbox commands do not receive real provider credentials. Setup
  runs after Junior removes the credential route from the build Sandbox.
- A Workspace switch prepares a candidate Sandbox before it updates durable or
  live state. A failed candidate leaves the current Sandbox unchanged.
- Missing or invalid snapshots rebuild through the owning snapshot path;
  callers do not mutate a cached snapshot in place.
- The hot Redis registry is install-wide and ignores `JUNIOR_STATE_KEY_PREFIX`.
  Build-time warmup requires durable Redis, not the memory adapter.
- Snapshot state never contains real provider credentials.
- The global baseline installs Docker and Compose clients plus
  `junior-ensure-docker`. Sandbox prepare starts `dockerd` so nested
  `docker compose` works after snapshot boot; the daemon is not part of the
  snapshot process tree.

## Network And Credentials

All credential-capable provider access follows
`../../../../../policies/security.md`. The verified egress implementation lives
under `egress/`; `snapshot/resolve.ts` owns snapshot acquisition.
