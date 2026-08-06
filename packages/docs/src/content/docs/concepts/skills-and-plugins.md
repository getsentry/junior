---
title: Skills & Plugins
description: How Junior gets instructions, tools, and external integrations.
type: conceptual
summary: Tell skills, plugins, tools, and sandbox commands apart.
prerequisites:
  - /start-here/overview/
related:
  - /extend/
  - /concepts/security-and-authority/
  - /concepts/resource-subscriptions/
---

Junior's capabilities come from a few different layers. They are easy to blur together, so keep them straight.

## Mental model

| Piece | Job |
| ----- | --- |
| Skills | Tell Junior how to do a kind of work |
| Core tools | Host-owned actions Junior can take |
| Plugins | Reviewed integrations you explicitly enable |
| MCP / provider tools | External tool surfaces exposed by a plugin |
| Sandbox commands | Isolated command execution for real work |

Skills are instructions. Plugins are code and manifests. Tools are the actions. The sandbox is where untrusted command execution happens.

## Skills

Skills are focused playbooks loaded when they match the task.

- Local skills live in `app/skills/<skill-name>/SKILL.md`
- Plugins can ship their own skills
- Skills should not own package installs, OAuth setup, or secret handling

If a skill needs a CLI, system package, MCP server, or credential flow, that belongs in a plugin manifest.

## Plugins

Plugins are trusted app code you opt into. Runtime does not scan `node_modules` for random plugins.

A plugin may declare:

- credentials and provider domains
- tools and MCP servers
- skills
- runtime dependencies
- routes and resource events

The host still owns auth brokering, queueing, validation, and action review. A plugin can add capability. It does not get to invent authority.

## Tools and review

Not every tool is equal.

- Core tools have explicit contracts and approval behavior.
- Plugin and MCP tools are external capability surfaces. Missing safety metadata is treated carefully.
- Destructive or open-world actions are more likely to need action review.
- Tool results are data, not new instructions that automatically widen access.

See [Security & Authority](/concepts/security-and-authority/) for how review fits in.

## Validation

```bash
pnpm exec junior check
```

Keep install steps, CLIs, MCP servers, and API-key wiring in `plugin.yaml` or the plugin definition so the reviewed manifest owns the runtime surface.

## Next step

Browse [Plugins](/extend/) for the integrations you can enable, then read [Resource Subscriptions](/concepts/resource-subscriptions/) if the plugin publishes events.
