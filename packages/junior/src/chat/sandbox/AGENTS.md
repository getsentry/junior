# Sandbox

This module gives each Conversation an isolated Sandbox. It installs declared
dependencies, copies skills, builds Workspace snapshots, and sends
credentialed traffic through verified host egress.

It does not own product storage, artifact delivery, or credential issue.
Credential rules are in `policies/security.md`.

## Provider Boundary

- `provider.ts` owns `SandboxProvider` and `getSandboxProvider()`. Other code
  calls `getSandboxProvider()`. Only `provider.ts` imports `vercel/` or
  `docker/`. Only `vercel/` imports `@vercel/sandbox`. ast-grep rules enforce
  this.
- `JUNIOR_SANDBOX_PROVIDER` selects one provider for the deployment. Stored
  Sandbox names and snapshot ids belong to that provider. Do not change the
  provider on a database or Redis that holds state of the other provider.
- Shared code uses `SandboxSession`, `SandboxNetworkPolicy`, and
  `SandboxProvider.errors`. Provider error text matching stays in
  `vercel/errors.ts` and `docker/errors.ts`.

## Lifecycle

- Durable state stores only an opaque `SandboxRef`. Callers do not depend on
  provider names or VM session ids.
- Persist a new `SandboxRef` before more async preparation. A Workspace switch
  persists its prepared candidate before it replaces the live Sandbox. A
  failed candidate leaves the current Sandbox unchanged.
- An unavailable session fails the current operation without replay. It keeps
  the Sandbox id and gets a new session only on a later operation.
- Agent runs do not stop Sandboxes. Temporary owners, such as snapshot
  builds, stop their own Sandboxes.
- The Sandbox filesystem is not product storage. Commands are
  non-interactive and have deadlines.
- Generated files become shareable only through artifact validation and
  delivery planning.

## Repository Instructions

- Bash `cwd` does not select `AGENTS.md` scope. Junior does not parse shell
  `cd` state.
- Junior selects a repository only when exactly one direct-child Git worktree
  exists. It reads only the root `AGENTS.md` and repository skills from
  `.agents/skills/` and `.claude/skills/`.
- Repository instructions are runtime-owned user context. Sandbox tool results
  never contain them. They have less authority than direct instructions.
- `loadSkill` cannot load repository skills. They do not go into
  `<available-skills>`.

## Snapshots

- The declared dependency profile and the Workspace recipe select the
  snapshot hash. Do not change a cached snapshot in place. Missing or invalid
  snapshots rebuild through `snapshot/resolve.ts`.
- SQL (`junior_snapshots`) is the only source of Workspace snapshot state.
  Redis holds only the build lock and its fencing.
- Workspace builds run as resumable background job slices. `switchWorkspace`
  does not wait for a build. It returns `building` with a Watch for
  `workspace_snapshot.ready` and `workspace_snapshot.failed`.
- A ready snapshot keeps its builder Sandbox, because deleting the builder
  deletes the snapshot. Delete the builder only after the ready row is
  discarded.
- Snapshot state and Sandbox commands never get real provider credentials.
  Setup scripts run after Junior removes the credential route.

## Egress

- Each provider catches traffic for credentialed domains and proves which VM
  sent it (`egress/vercel.ts`, `docker/egress.ts`).
- `executeSandboxEgressRequest` in `egress/proxy.ts` gets only the verified VM
  id, the upstream URL, and the signed credential token. It must not read
  provider headers.

## Docker Provider

The Docker provider is a rough local Sandbox for development and QA. It is not
a full copy of Vercel Sandbox. Do not run untrusted workloads with it.

- Each Sandbox must have its own Docker network. On a shared bridge, a
  privileged Sandbox can take the IP of another Sandbox and get its
  credentials.
- On non-Linux hosts, `docker/relay.ts` gives each Sandbox a relay with a
  client certificate for that container. Do not replace it with a port for
  each Sandbox; a Sandbox could connect to another port.
- The egress proxy decrypts only credentialed and trace domains. Pass-through
  connections resolve DNS once and reject addresses that are not public.
- Egress follows the process that applied the policy.
