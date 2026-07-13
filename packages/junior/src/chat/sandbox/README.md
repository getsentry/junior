# Sandbox Runtime

The sandbox module creates isolated workspaces, installs declared runtime
dependencies, synchronizes skills, and proxies credential-capable network
traffic through verified host egress.

## Lifecycle

- Sandboxes are ephemeral execution environments associated with a durable
  conversation or run.
- Persist only the sandbox identifier and durable artifact metadata needed to
  resume work; do not treat the sandbox filesystem as product storage.
- Commands are non-interactive and bounded by runtime deadlines.
- Generated files become shareable only after artifact validation and
  destination-aware delivery planning.

## Dependency Snapshots

- The declared plugin/runtime dependency profile is the source of truth.
- A deterministic profile hash selects a reusable snapshot.
- Snapshot creation installs only the declared dependencies and post-install
  steps for that profile.
- Missing or invalid snapshots rebuild through the owning snapshot path;
  callers do not mutate a cached snapshot in place.
- Snapshot state never contains real provider credentials.

## Network And Credentials

All credential-capable provider access follows
`../../../../../policies/security.md`. The verified egress implementation lives
under `egress/`; `runtime-dependency-snapshots.ts` owns snapshot acquisition.
