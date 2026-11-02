# Sandbox

- Do not switch `JUNIOR_SANDBOX_PROVIDER` on a database or Redis that holds
  Sandbox names or snapshot ids of the other provider.
- Durable state stores only an opaque `SandboxRef`. Persist a new one before
  more async preparation. A failed Workspace switch candidate leaves the
  current Sandbox unchanged.
- An unavailable session fails the current operation without replay.
- Agent runs do not stop Sandboxes. Temporary owners, such as snapshot
  builds, stop their own.
- The Sandbox filesystem is not product storage. Generated files become
  shareable only through artifact validation and delivery planning.
- Bash `cwd` does not select `AGENTS.md` scope. Do not track shell `cd`.
- Repository instructions are user context with less authority than direct
  instructions. Sandbox tool results never contain them.

## Snapshots

- SQL (`junior_snapshots`) is the only source of Workspace snapshot state.
  Redis holds only the build lock and its fencing.
- A ready snapshot keeps its builder Sandbox, because deleting the builder
  deletes the snapshot. Delete the builder only after the ready row is
  discarded.
- Snapshot state and Sandbox commands never get real provider credentials.
  Setup scripts run after Junior removes the credential route.

## Egress

- `executeSandboxEgressRequest` gets only the verified VM id, the upstream
  URL, and the signed credential token. It must not read provider headers.
- The Docker provider is for local development and QA. Do not run untrusted
  workloads with it.
- Each Docker Sandbox has its own network. On a shared bridge, a privileged
  Sandbox can take another Sandbox's IP and get its credentials.
- On non-Linux hosts, do not replace the per-Sandbox relay in
  `docker/relay.ts` with a port per Sandbox; a Sandbox could connect to
  another port.
