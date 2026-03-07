---
title: Skills & Plugins
description: How local skills and plugin-provided capabilities are composed.
type: conceptual
summary: Understand how skills and plugins compose capabilities while keeping runtime wiring stable.
prerequisites:
  - /start-here/overview/
related:
  - /extend/plugins-overview/
  - /extend/custom-plugins/
---

## Mental model

- Skills define focused instruction bundles.
- Plugins declare optional capabilities, optional credentials, and optional skills.
- Runtime selects and executes skills based on task context plus capability access.

## Skill sources

- Local skills: `app/skills/<skill-name>/SKILL.md`
- Plugin skills: shipped in installed plugin packages

## Capability gating

Capabilities are not implicitly granted. Runtime actions that require credentials must issue capability-scoped credentials explicitly.

## Validation

```bash
pnpm skills:check
```

## Next step

- [Plugins Overview](/extend/plugins-overview/)
- [Custom Plugins](/extend/custom-plugins/)
