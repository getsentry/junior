# Sandbox

Gives each Conversation an isolated Sandbox: dependencies, skills, Workspace
snapshots, and credentialed traffic through verified host egress. It does not
own product storage, artifact delivery, or credential issue.

## Provider Boundary

- Call `getSandboxProvider()` in `provider.ts`. Only `provider.ts` imports
  `vercel/` or `docker/`. Only `vercel/` imports `@vercel/sandbox`. ast-grep
  rules enforce this.
- `JUNIOR_SANDBOX_PROVIDER` selects one provider per deployment. Stored
  Sandbox names and snapshot ids belong to it. Do not switch providers on a
  database or Redis that holds state of the other one.
- Shared code uses `SandboxSession`, `SandboxNetworkPolicy`, and
  `SandboxProvider.errors`. Error text matching stays in `vercel/errors.ts`
  and `docker/errors.ts`.

## Lifecycle

- Durable state stores only an opaque `SandboxRef`, never provider names or
  VM session ids.
- Persist a new `SandboxRef` before more async preparation. A Workspace switch
  persists its candidate before it replaces the live Sandbox. A failed
  candidate leaves the current Sandbox unchanged.
- An unavailable session fails the current operation without replay. It keeps
  the Sandbox id and gets a new session on a later operation.
- Agent runs do not stop Sandboxes. Temporary owners, such as snapshot
  builds, stop their own.
- The Sandbox filesystem is not product storage. Commands are
  non-interactive and have deadlines.
- Generated files become shareable only through artifact validation and
  delivery planning.

## Repository Instructions

- Bash `cwd` does not select `AGENTS.md` scope. Junior does not track shell
  `cd`.
- Junior selects a repository only when exactly one direct-child Git worktree
  exists. It reads only the root `AGENTS.md` and skills in `.agents/skills/`
  and `.claude/skills/`.
- Repository instructions are runtime-owned user context with less authority
  than direct instructions. Sandbox tool results never contain them.
- Repository skills are not in `<available-skills>`, and `loadSkill` cannot
  load them.

## Snapshots

- The dependency profile and the Workspace recipe select the snapshot hash.
  Do not change a cached snapshot in place. Missing or invalid snapshots
  rebuild through `snapshot/resolve.ts`.
- SQL (`junior_snapshots`) is the only source of Workspace snapshot state.
  Redis holds only the build lock and its fencing.
- Workspace builds run as resumable background job slices. `switchWorkspace`
  does not wait. It returns `building` with a Watch for
  `workspace_snapshot.ready` and `workspace_snapshot.failed`.
- Deleting the builder Sandbox deletes its snapshot. Delete it only after the
  ready row is discarded.
- Snapshot state and Sandbox commands never get real provider credentials.
  Setup scripts run after Junior removes the credential route.

## Egress

- Each provider catches traffic for credentialed domains and proves which VM
  sent it (`egress/vercel.ts`, `docker/egress.ts`).
- `executeSandboxEgressRequest` in `egress/proxy.ts` gets only the verified VM
  id, the upstream URL, and the signed credential token. It must not read
  provider headers.

## Docker Provider

A rough local Sandbox for development and QA. Do not run untrusted workloads
with it.

- Each Sandbox has its own Docker network. On a shared bridge, a privileged
  Sandbox can take another Sandbox's IP and get its credentials.
- On non-Linux hosts, `docker/relay.ts` gives each Sandbox a relay with a
  client certificate for that container. Do not replace it with a port per
  Sandbox; a Sandbox could connect to another port.
- The egress proxy decrypts only credentialed and trace domains. Pass-through
  connections resolve DNS once and reject non-public addresses.
- Egress follows the process that applied the policy.
