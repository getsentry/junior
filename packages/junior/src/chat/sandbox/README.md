# Sandbox Runtime

The sandbox module creates isolated workspaces, installs declared runtime
dependencies, synchronizes skills, and proxies credential-capable network
traffic through verified host egress.

## Provider

- `provider.ts` owns the `SandboxProvider` contract and `getSandboxProvider()`.
  Sandbox code calls `getSandboxProvider()`, not a provider module.
  `JUNIOR_SANDBOX_PROVIDER` selects the provider for the whole deployment. The
  default is `vercel`. `docker` selects the local Docker provider. Stored
  sandbox names and snapshot ids belong to one provider, so do not switch the
  provider on a database or Redis that holds the other provider's state.
- `vercel/` implements `SandboxProvider` for Vercel Sandbox. `vercel/provider.ts`
  exports the provider. Only files in `vercel/` import `@vercel/sandbox`.
- `docker/` implements `SandboxProvider` with a local Docker daemon. See
  "Docker Provider" below.
- Only `provider.ts` imports `vercel/` or `docker/`. ast-grep rules enforce
  these boundaries.
- Provider modules hold only provider-specific declarations and logic. Shared
  types live in `provider.ts`, `workspace.ts`, and `snapshot/workspace.ts`.
- Other sandbox code uses `SandboxSession` and `SandboxNetworkPolicy`. Only
  `vercel/` uses Vercel credentials (`vercel/credentials.ts`), request options,
  and SDK objects.
- `SandboxNetworkPolicy` is provider-neutral. It lists the domains that go
  through Junior's credentialed egress and the domains that get trace headers.
  Every other domain stays open. Each provider turns it into its own network
  rules.
- Each provider sorts its own errors through `SandboxProvider.errors`. Shared
  code asks whether an error means the session is unavailable, the Sandbox or
  snapshot is missing, a snapshot is still being captured, the API failed for a
  short time, or a command stream ended early. `vercel/errors.ts` matches
  Vercel's error text, and `docker/errors.ts` matches Docker Engine API errors.
  `errors.ts` keeps only checks and wrappers that do not depend on a provider.

## Lifecycle

- Sandboxes are ephemeral execution environments associated with a durable
  conversation or run.
- Runtime state persists only an opaque `SandboxRef` (`id`, dependency profile
  hash, and optional Workspace id). `vercel/provider.ts` maps that reference
  to Vercel's named Sandbox API; callers do not depend on provider names or VM
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
- Junior also lists the repository skills in `.agents/skills/` and
  `.claude/skills/` at the Git root. The first directory wins when both have a
  skill with the same name. The list holds the name, description, and
  `SKILL.md` path of each skill. Junior leaves out skills that set
  `disable-model-invocation`. The model reads a skill body with `readFile`.
  Repository skills do not go into `<available-skills>`, and `loadSkill`
  cannot load them.
- `AGENTS.md` comes first in the shared byte budget. Repository skills use the
  remaining budget, one whole entry at a time.
- Repository skills have the same trust level as `AGENTS.md`. Direct
  instructions take precedence over both.
- Overrides, Git hooks, recursive repository discovery, and filesystem
  watchers are intentionally out of scope.

## Dependency Snapshots

- The declared plugin/runtime dependency profile is the source of truth.
- A deterministic profile hash selects a reusable snapshot.
- Snapshot creation installs only the declared dependencies and post-install
  steps for that profile.
- A Workspace recipe is part of the profile hash. One build installs runtime
  dependencies, prepares repositories, runs setup, and captures the complete
  snapshot. Operators manage recipes from `/system/workspaces` or
  `/api/workspaces`. The `junior_snapshots` table records each build as
  `building`, `failed`, or `ready`. A cold build runs on a background job with
  one named Sandbox for up to one hour. Short job slices create the builder,
  install dependencies, prepare repositories, start setup, and poll setup. Each
  slice records its phase in SQL. The next job can continue after a soft yield
  or a worker stop.
- When `switchWorkspace` finds no ready snapshot, it returns
  `status: "building"` and a temporary watch for
  `workspace_snapshot.ready` and `workspace_snapshot.failed`. It does not keep
  the tool call open. The build job publishes those core `junior` events when it
  finishes. The next Turn should call `switchWorkspace` again with the same
  name. Other sandbox tools use the same plain preparing message when the
  snapshot is not ready yet.
- SQL is the only source of Workspace snapshot state. Redis coordinates the
  build lock and its fencing. It does not store Workspace snapshot pointers.
- Workspace repositories clone to fixed `repos/{name}` paths. Setup scripts
  receive `JUNIOR_WORKSPACE_ROOT` and `JUNIOR_REPOS_ROOT` so they do not depend
  on the provider's absolute Sandbox path.
- Repository preparation uses host egress for provider credentials. Junior
  full-clones missing repositories so Workspace checkouts keep normal git
  history. When a checkout already exists, Junior refreshes the current branch
  to its upstream and removes non-ignored untracked files. Snapshot state and
  Sandbox commands do not receive real provider credentials. Setup runs after
  Junior removes the credential route from the build Sandbox.
- A Workspace switch prepares a candidate Sandbox before it updates durable or
  live state. A failed candidate leaves the current Sandbox unchanged.
- Missing or invalid snapshots rebuild through the owning snapshot path;
  callers do not mutate a cached snapshot in place.
- A ready snapshot retains its named builder Sandbox. Deleting that Sandbox
  would also delete the snapshot it owns. Junior deletes the builder after it
  discards the ready row because the recipe changed, the snapshot is stale or
  missing, another snapshot replaced it, or the Workspace was deleted.
- Snapshot state never contains real provider credentials.
- The global baseline installs Docker and Compose clients plus
  `junior-ensure-docker`. Sandbox prepare starts `dockerd` so nested
  `docker compose` works after snapshot boot; the daemon is not part of the
  snapshot process tree. `guest-docker.ts` owns this setup. It runs inside the
  guest through `runCommand`, so it works with any provider.

## Network And Credentials

All credential-capable provider access follows
`../../../../../policies/security.md`. The verified egress implementation lives
under `egress/`; `snapshot/resolve.ts` owns snapshot acquisition.

Sandbox egress has two parts:

- **Provider part:** each sandbox provider catches sandbox traffic for
  credentialed domains and proves which sandbox VM sent each request.
  `egress/vercel.ts` is the Vercel part. It turns the policy into Vercel
  `forwardURL` and header `transform` rules. Vercel then forwards requests to
  Junior's egress route with a Vercel OIDC token and `vercel-forwarded-*`
  headers. `egress/vercel.ts` verifies the token and rebuilds the upstream URL.
  `egress/oidc.ts` checks the token against Vercel's OIDC issuer.
- `docker/egress.ts` is the Docker part. See "Docker Provider" below.
- **Shared part:** `executeSandboxEgressRequest` in `egress/proxy.ts` takes
  the verified VM id, the upstream URL, and the signed credential token. It
  checks provider ownership and the credential context, then runs the shared
  credentialed egress engine. It does not read provider headers.

## Docker Provider

The Docker provider gives the dev stack a rough Linux sandbox on a local Docker
daemon. It is for local development and for Junior QA inside a Vercel Sandbox.
It implements every `SandboxProvider` operation. It is not a full copy of
Vercel Sandbox, and some workloads do not behave the same. Set
`JUNIOR_SANDBOX_PROVIDER=docker` to use it. The contributor guide
`packages/docs/src/content/docs/contribute/development.md` explains the setup.

### How It Works

- **Engine API:** `docker/api.ts` talks to the Docker daemon over its unix
  socket with `node:http`. `DOCKER_HOST` can name another unix socket. TCP
  daemons are not supported.
- **Runtime image:** `docker/runtime-image.ts` builds
  `junior-sandbox-runtime:node22-<hash>` from `amazonlinux:2023` on first use.
  It adds Node 22, `dnf`, passwordless `sudo`, the `vercel-sandbox` user, and
  the workspace directory, so the same dependency installs and paths work.
- **Sandbox:** each sandbox is a named, privileged container. Commands run as
  `vercel-sandbox`, or as root with `sudo`. Docker exec cannot kill a command,
  so each command runs in its own process group and abort kills that group.
  Files use Docker's archive API.
- **Own network:** each sandbox gets its own Docker network with a subnet from
  `10.213.0.0/16`. This is required. On a shared bridge, a privileged sandbox
  can take another sandbox's IP and MAC address and get its credentials. The
  range also stays clear of the default address pools of the inner Docker
  daemon. Junior removes sandbox networks without a container when it creates
  the next sandbox.
- **Start script:** PID 1 of each container is a small script under
  `docker-init`. It removes a stale `docker.pid` that a snapshot or restart
  leaves behind. It also stops the container when its timeout passes.
  `extendTimeout` moves that deadline. Junior waits until the script is ready.
  Session prepare then starts the inner `dockerd` through `guest-docker.ts`, the
  same as on Vercel.
- **Lifecycle:** a sandbox that is not persistent removes itself when it
  stops, like on Vercel. A later `getSession` then reports it missing. A
  persistent sandbox keeps its files and starts again on `getSession`.
- **Snapshots:** `docker commit` captures a sandbox as a local image tagged
  `junior-sandbox-snapshot:<sandbox name>`. The image id is the snapshot id.
  Docker's "No such image" error counts as a missing snapshot, so the normal
  rebuild path runs. A Workspace builder is removed right after its commit,
  because the image does not depend on it. Deleting the builder later removes
  the image tag that carries its name.
- **Workspace builds:** a detached command writes its output and exit code to
  files in the container. Any Junior process can wait for it by id, so the
  sliced build jobs work as on Vercel.

### Egress

- `applyEgressPolicy` adds iptables rules in the sandbox container. They send
  TCP traffic to ports 80 and 443 on public addresses to a proxy in this Junior
  process. The rules also catch traffic from the agent's inner containers.
  `allow-all` removes the rules.
- On Linux, the proxy knows each sandbox by its IP on the sandbox's own
  network. It checks with Docker that the address still belongs to that
  container.
- On macOS and other hosts, the Docker daemon runs in a VM. The sandbox cannot
  reach the proxy through its gateway, and the proxy sees one VM address for
  every sandbox. So `docker/relay.ts` starts an egress relay container on the
  sandbox's own network, and the rules send traffic to it. The relay runs
  `socat` and sends each connection to the proxy at `host.docker.internal`
  over TLS. Its client certificate names the sandbox's container id, and the
  egress CA signs it. The proxy then accepts only connections with a valid
  client certificate. Only one sandbox can reach each relay, and the relay key
  stays in the relay container, so a sandbox cannot use another sandbox's
  identity. A port per sandbox without this check would not be safe, because
  a sandbox could connect to another sandbox's port.
- The redirect hides the original address. So the proxy reads the host from
  TLS SNI or from the HTTP `Host` header. It decrypts only credentialed and
  trace domains. Credentialed requests go to `executeSandboxEgressRequest`.
  Trace requests get their headers and go upstream. All other connections
  pass through with their real certificates.
- The proxy and its routes live in the process that applied the policy. That
  process runs the sandbox's commands and reads the auth-required signals that
  the egress engine writes, also with the memory state adapter. Each policy
  update points the sandbox's rules at this process's proxy.
- The proxy decrypts traffic with a machine-wide CA in
  `~/.cache/junior/docker-sandbox` (`JUNIOR_DOCKER_SANDBOX_DIR` overrides it).
  Each sandbox has the CA in its system trust store. `NODE_EXTRA_CA_CERTS`,
  `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, and `AWS_CA_BUNDLE`
  point at the system bundle for runtimes that do not read that store.
- When the Docker host itself is behind a TLS proxy, such as inside a Vercel
  Sandbox, set `JUNIOR_DOCKER_SANDBOX_EXTRA_CA_CERTS` to that proxy's CA file.
  Each sandbox then trusts it too.

### Limitations

We accept these limits. The goal is a rough Linux sandbox that runs most of
the dev stack, not every workload.

- **Snapshots do not keep inner Docker images.** Each sandbox mounts its own
  volume at `/var/lib/docker` for its inner `dockerd`, and `docker commit`
  skips volumes. A sandbox from a snapshot starts with an empty inner Docker
  and pulls images again on first use. On Vercel, snapshots keep those images.
  Without the volume, the inner `dockerd` falls back to the slow `vfs` storage
  driver, which makes commits very large, and the baseline needs `overlay2`.
  Saving the volume with each snapshot would fix this, but it adds code for a
  small dev gain.
- **Snapshots stay on one daemon.** They are local image ids, not registry
  images. If the image is deleted, Junior rebuilds it through the normal
  missing-snapshot path. Base snapshot images are not removed automatically.
  Remove them with
  `docker image prune -a --filter label=dev.junior.sandbox=snapshot`.
- **Sandboxes are privileged.** Nested Docker and the egress rules need it. Do
  not run untrusted workloads with this provider.
- **Only ports 80 and 443 are caught.** Other ports and DNS go out directly.
  This exposes no credentials, because the sandbox never has them. A
  connection to port 80 or 443 without a host name, such as TLS to a bare IP,
  cannot be routed and is closed.
- **Some clients do not trust the CA.** Java's keystore, binaries with
  compiled-in CA roots, and the agent's inner containers fail TLS to
  credentialed and trace domains. They fail closed: no credentials leak, and
  other domains still work.
- **Egress follows one process.** When the process that applied a sandbox's
  policy exits, that sandbox's web traffic fails until another process
  acquires the sandbox and applies its policy again.
- **No credit-based idle stop.** A sandbox stops only when its timeout passes.
  Containers that stop early, for example when the daemon restarts, lose their
  running commands, and a Workspace build then fails and starts again.
- **macOS uses the egress relay.** It was checked on Linux with the relay
  forced on. OrbStack showed the original problem. Docker Desktop is not
  verified. A privileged sandbox can reach the Docker VM, and with it the relay
  key, so the relay does not make untrusted workloads safe.
