# Architecture Audit — April 2026

**Goal:** Identify structural issues, convention violations, and coupling that
blocks multi-provider messaging and multi-platform deployment.

**Verdict:** The codebase is clean (no significant dead code or bloat). The
plugin system already supports zero-touch provider additions. The blockers are
Slack type leakage into provider-agnostic layers, Vercel platform coupling in a
few key files, and a handful of mutable runtime globals.

---

## 1. Slack Coupling in Provider-Agnostic Layers

**Severity: High — blocks non-Slack messaging providers**

The `chat` SDK is generically typed (`Chat<TAdapters extends Record<string, Adapter>>`),
so the framework supports multiple providers. But Junior leaks Slack into
runtime and services:

### Type leakage (violates chat-architecture-spec)

| File | Issue |
|------|-------|
| `runtime/slack-runtime.ts` | Imports `SlackAdapter` type directly |
| `runtime/reply-executor.ts` | Imports `SlackAdapter` type directly |
| `runtime/assistant-lifecycle.ts` | Imports `SlackAdapter` type directly |

The spec says: "Do not leak third-party SDK types across chat subsystem
boundaries when a small local interface will do."

### Slack-named dependencies in service interfaces

| File | Issue |
|------|-------|
| `services/vision-context.ts` | Interface requires `downloadPrivateSlackFile` and `listThreadReplies` |
| `queue/thread-message-dispatcher.ts` | Accepts `downloadPrivateSlackFile` in options |

These should be provider-agnostic: `downloadAttachment(url)`,
`getThreadMessages(threadId)`.

### Provider-specific fields in shared state

| File | Issue |
|------|-------|
| `state/conversation.ts` | Persists `slackTs` in `ConversationMessageMeta` |
| Logging contexts in `runtime/` | Hardcoded `slackThreadId`, `slackChannelId`, `slackUserId` |

### Properly scoped Slack code (no action needed)

- `chat/slack/` — Slack infrastructure module (client, channel, user, output, emoji)
- `chat/tools/slack/` — Slack-specific tool implementations
- `chat/app/production.ts` — Composition root (legitimate place for concrete types)
- `chat/app/factory.ts` — Composition root

### Recommended fix

Define small consumer-owned interfaces in the service/runtime layer for
messaging operations. Have the Slack adapter implement them. Replace
`SlackAdapter` imports in `runtime/` with those interfaces. Rename
`slackTs` → `sourceMessageId`, Slack-named log fields → generic names.

---

## 2. Vercel Platform Coupling

**Severity: Medium — blocks non-Vercel deployment**

### Sandbox: contained, 2 files to change

`@vercel/sandbox` is imported in exactly 2 files:
- `sandbox/sandbox.ts`
- `sandbox/runtime-dependency-snapshots.ts`

Consumers only see the `SandboxExecutor` interface. Swapping runtimes requires
extracting a `SandboxProvider` interface behind those 2 files.

### Platform env detection: scattered but with fallbacks

| File | Vercel-Specific Usage |
|------|----------------------|
| `app.ts` | `waitUntil` from `@vercel/functions` (has fire-and-forget fallback) |
| `instrumentation.ts` | `VERCEL_ENV`, `VERCEL_GIT_COMMIT_SHA` |
| `chat/oauth-flow.ts` | `VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL` |
| `chat/pi/client.ts` | `VERCEL_OIDC_TOKEN` for AI gateway auth |
| `chat/sandbox/credentials.ts` | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` |
| `nitro.ts` | `nitro.options.vercel.functions.maxDuration` |
| `cli/init.ts` | Scaffolds `vercel.json` only |

### Recommended fix

Abstract platform detection into a `PlatformAdapter` interface (URL resolution,
OIDC token, waitUntil, sandbox credentials). Inject it at the composition root.

---

## 3. Nitro Coupling

**Severity: Low — appropriate for build, minor Vercel leak**

The app uses Hono for HTTP routing (portable). Nitro is build-time only:
- Plugin discovery and file copying (`juniorNitro()` module)
- Virtual module injection (`#junior/config`)
- Server entry point pattern

The Hono app works anywhere. The only issue is `juniorNitro()` sets
Vercel-specific `maxDuration`. For non-Nitro builds, you'd need an alternative
plugin packaging mechanism, but the runtime is clean.

---

## 4. Mutable Runtime Globals

**Severity: Medium — violates architecture discipline**

| File | Global | Purpose |
|------|--------|---------|
| `chat/app/production.ts` | `productionBot`, `productionSlackRuntime` | Lazy singleton |
| `chat/plugins/package-discovery.ts` | `configuredPluginPackages` | Set once at startup via `setPluginPackages()` |
| `chat/slack/client.ts` | `client` (WebClient) | Lazy singleton |
| `chat/respond.ts` | `startupDiscoveryLogged` | One-time log guard |
| `chat/capabilities/catalog.ts` | `cachedCatalog`, `catalogLogged` | Capability cache + log guard |

The spec says: "Do not add mutable runtime behavior globals or test-only
singleton mutation APIs."

The production singleton (`getProductionBot()`) is the most impactful — it
makes the bot instance ambient rather than explicitly threaded through handlers.

---

## 5. Documented Debt (from chat-architecture-spec)

These are already tracked but worth noting:

1. Plugin/capability discovery still uses module-level catalog cache instead of
   fully injected catalogs
2. Eval harness still owns too many environment/runtime control knobs
3. Legacy `botConfig` compatibility export still exists

---

## 6. Dead Code & Bloat

**Severity: None — codebase is clean**

- No unused exports found (spot-checked)
- No barrel `index.ts` in feature subdirectories
- No `ForTests` mutation APIs
- No prototype patching or import-side-effect modules
- No unused dependencies
- No backward-compatibility shims (the Sentry re-export in `sentry.ts` is an
  intentional anti-corruption layer)
- Archived specs in `specs/archive/` are properly labeled

Minor items:
- `LEGACY_KEY_MAP` in logging (backward-compat shim for log keys)
- `resetSkillDiscoveryCache()` exists but is used in tests

---

## 7. Multi-Provider Readiness

### Already provider-agnostic

- **Plugin system** — YAML manifests, zero core changes to add providers
- **Agent layer** — Pi-agent encapsulated in `respond.ts`, generic `ToolDefinition`
- **Tool definitions** — Slack tools are just `ToolDefinition` implementations
- **State adapter** — memory/Redis, decoupled from messaging provider
- **Chat SDK type system** — generic `TAdapters` allows multi-provider
- **Sandbox executor** — interface-based, consumers don't see `@vercel/sandbox`

### Blocks non-Slack messaging

- `SlackAdapter` type in `runtime/` (3 files)
- Slack-named function types in service interfaces (2 files)
- `slackTs` in conversation state (1 file)
- Slack field names in log contexts (throughout `runtime/`)
- Production wiring only creates Slack adapter

### Blocks non-Vercel deployment

- Sandbox provider needs pluggable abstraction (2 files)
- Platform env detection needs adapter (5+ files)
- CLI init only scaffolds Vercel config

---

## 8. Recommended Priority

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 1 | Abstract `SlackAdapter` out of `runtime/` | Unblocks multi-provider | Medium |
| 2 | Abstract platform env detection | Unblocks multi-platform | Small |
| 3 | Rename Slack-specific fields in services/state | Convention compliance | Small |
| 4 | Extract `SandboxProvider` interface | Unblocks non-Vercel sandbox | Small |
| 5 | Address documented debt (catalog injection, botConfig) | Spec compliance | Medium |
| 6 | Reduce mutable globals | Architecture discipline | Medium |
