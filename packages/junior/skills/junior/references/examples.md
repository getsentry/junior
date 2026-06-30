# Examples

## App Skill

```text
app/skills/release-notes/
└── SKILL.md
```

```markdown
---
name: release-notes
description: Draft release notes from local project context. Use for changelog bullets and unreleased-change summaries. Do not use for publishing releases or changing version files.
---

# Release Notes

1. Identify the release range or ask for it.
2. Inspect local changelog, commits, and issue references.
3. Draft user-facing bullets grouped by feature, fix, and operational note.
4. Call out missing validation.

## Guardrails

- Do not change files unless asked.
- Do not invent issue links or customer impact.
```

Checks:

- `app/skills`: no provider authority.
- Description has positive and negative triggers.
- Validate with `pnpm exec junior check`.

## App Plugin

```text
app/plugins/acme/
├── plugin.yaml
└── skills/
    └── acme/
        └── SKILL.md
```

```yaml
name: acme
description: Acme support data lookup

capabilities:
  - api.read

env-vars:
  ACME_AUTH_HEADER:
  ACME_REGION:
    default: us

domains:
  - api.acme.example
api-headers:
  Authorization: ${ACME_AUTH_HEADER}

mcp:
  url: https://mcp.${ACME_REGION}.acme.example/mcp
  allowed-tools:
    - search_customers
    - fetch_customer
```

```markdown
---
name: acme
description: Look up Acme support data through the Acme plugin. Use for customer records, account status, or Acme support context. Do not use for writes or non-Acme data.
---

# Acme Support Lookup

1. Classify as customer search, fetch, or account-status lookup.
2. Prefer explicit customer IDs, domains, or account names.
3. Use read-only Acme provider tools.
4. Summarize only necessary customer data.

## Guardrails

- Read-only only.
- If runtime surface is unavailable, report an Acme plugin setup failure.
```

Checks:

- Secrets stay in deployment env.
- MCP/header setup is manifest-owned.
- Skill describes behavior only.

## Anti-Pattern

```markdown
---
name: acme
description: Work with Acme.
requires-capabilities:
  - acme.api.read
uses-config:
  - acme.region
---

# Acme

Run `pnpm add acme-cli`, export `ACME_TOKEN`, configure MCP, then call `callMcpTool`.
```

Wrong:

- deprecated frontmatter
- package/token/config/MCP setup in skill prose
- secret handling in model-visible workflow
- hardcoded dispatcher mechanics

Fix:

```yaml
name: acme
description: Acme support data lookup

capabilities:
  - api.read

config-keys:
  - region

credentials:
  type: oauth-bearer
  domains:
    - api.acme.example
  auth-token-env: ACME_AUTH_TOKEN
  auth-token-placeholder: host_managed_credential

oauth:
  client-id-env: ACME_CLIENT_ID
  client-secret-env: ACME_CLIENT_SECRET
  authorize-endpoint: https://acme.example/oauth/authorize
  token-endpoint: https://acme.example/oauth/token

runtime-dependencies:
  - type: npm
    package: acme-cli

mcp:
  url: https://mcp.acme.example/mcp
  allowed-tools:
    - search_customers
    - fetch_customer
```

```markdown
---
name: acme
description: Look up Acme support data. Use for Acme customer searches and account-status lookups. Do not use for customer mutations or unrelated provider data.
---

# Acme Lookup

1. Resolve the customer from explicit user input.
2. Use read-only Acme commands or provider tools.
3. Return a concise answer with record IDs.
4. Report Acme plugin setup issues when auth/runtime is unavailable.
```

## Package

```text
junior-plugin-acme/
├── package.json
├── plugin.yaml
└── skills/
    └── acme/
        └── SKILL.md
```

```json
{
  "name": "@acme/junior-plugin-acme",
  "private": false,
  "type": "module",
  "files": ["plugin.yaml", "skills"]
}
```

Validate:

1. Package/repo checks.
2. Add package name or plugin factory to `defineJuniorPlugins(...)`.
3. `pnpm exec junior check` for app-local files.
4. Runtime load or parser test for packaged `plugin.yaml`.
5. One real workflow after env is configured.
