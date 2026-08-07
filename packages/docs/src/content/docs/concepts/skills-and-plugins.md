---
title: Skills & Plugins
description: How Junior gets instructions, tools, and external integrations.
type: conceptual
summary: Understand the difference between skills, tools, plugins, and sandbox commands.
prerequisites:
  - /start-here/overview/
related:
  - /extend/
  - /concepts/security-and-authority/
  - /concepts/resource-subscriptions/
---

Junior combines instructions with configured capabilities.

## Components

| Component | Purpose |
| --------- | ------- |
| Skill | Instructions for a type of work |
| Tool | An action Junior can take |
| Plugin | An integration enabled by the app operator |
| Sandbox | Isolated command execution |

## Skills

Skills are focused playbooks loaded when they match the request.

- Local skills live in `app/skills/<skill-name>/SKILL.md`.
- Plugins can include their own skills.
- Skills do not install packages, configure OAuth, or grant access.

If a skill needs a CLI, system package, MCP server, or credential flow, declare it in the plugin instead.

## Plugins

Junior loads plugins only from explicit app configuration. A plugin can register:

- tools and skills
- provider credentials and domains
- MCP servers
- runtime dependencies
- routes and resource events

Plugins run as trusted application code. The host still owns credential handling, validation, action review, and durable execution.

## Tools

Core tools are part of Junior. Plugins and MCP servers can add more tools. Every tool has an input contract, and actions may require review before they run.

Tool output is treated as data. It cannot change the active user, destination, or credential authority.

## Validate Configuration

```bash
pnpm exec junior check
```

Keep package installs, CLIs, MCP servers, and API-key configuration in `plugin.yaml` or the plugin definition.

## Next Step

Browse [Plugins](/extend/) for available integrations. Read [Security & Authority](/concepts/security-and-authority/) for capability and review boundaries.
