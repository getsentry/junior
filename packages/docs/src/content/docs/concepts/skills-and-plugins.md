---
title: Skills & Plugins
description: How local skills and plugin-provided capabilities are composed.
type: conceptual
prerequisites:
  - /start-here/quickstart/
related:
  - /extend/
---

## Mental model

Skills tell Junior how to behave. Plugins tell Junior what external capability
surface and credential sources may exist.

- Skills define focused instruction bundles.
- Plugins declare optional capabilities, optional credentials, and optional skills.
- Runtime selects and executes skills based on task context, then uses the loaded skills to constrain credential access.
- Plugins own runtime setup. If a skill needs a CLI, system package, MCP server, OAuth provider, or token delivery path, that requirement belongs in the plugin manifest instead of the skill prose.

## Skill sources

- Local skills: `app/skills/<skill-name>/SKILL.md`
- Plugin skills: shipped in installed plugin packages

## Capability gating

Credentials are not ambient. When a loaded skill runs an authenticated command,
the runtime infers the narrowest declared capability for that command, fetches
the credential for the current requester and turn, and injects it automatically.
If no loaded skill declares the needed capability, the command runs without
provider auth.

## Validation

```bash
pnpm skills:check
```

Move package installs, CLI bootstraps, MCP server setup, and API-key configuration to `plugin.yaml` so reviewed manifests, not arbitrary skill instructions, control the runtime authority surface.

## Next step

- [Plugins](/extend/)
