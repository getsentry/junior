# Skill Authoring

## Required structure

```markdown
---
name: release-helper
description: Prepare release notes from local project context. Use when users ask Junior to draft release notes or summarize unreleased changes.
---

# Release Helper

1. Inspect the requested release range.
2. Summarize user-visible changes.
3. Call out missing validation.
```

## Frontmatter contract

| Field                   | Rule                                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | Required string. Must match the directory name. Use lowercase letters, digits, and hyphens; no leading, trailing, or repeated hyphens. Maximum 64 chars. |
| `description`           | Required string. Must be non-empty, under 1024 chars, and contain no angle brackets. Include realistic trigger and anti-trigger language.                |
| `metadata`              | Optional object. Use only when runtime or UI code reads it.                                                                                              |
| `compatibility`         | Optional string, maximum 500 chars.                                                                                                                      |
| `license`               | Optional string.                                                                                                                                         |
| `allowed-tools`         | Optional whitespace-separated string of allowed tool names.                                                                                              |
| `requires-capabilities` | Forbidden. Plugin capabilities come from `plugin.yaml`.                                                                                                  |
| `uses-config`           | Forbidden. Plugin config keys come from `plugin.yaml`.                                                                                                   |

## Body

- Start with what the skill does and when to use it.
- Use ordered workflows, short guardrails, and direct reference links.
- Keep every instruction actionable.
- Load optional depth through `references/*.md` instead of expanding `SKILL.md`.
- Use domain language.
- Plugin-backed skills describe operations, not setup.

## Description

- Include user phrases likely to appear in requests.
- Include negative trigger language for adjacent workflows.
- Mention the target domain, not implementation internals.

## Never in skill prose

- Package-manager installs, binary downloads, or bootstrap scripts.
- API tokens, OAuth client secrets, user-specific credentials, or credential-file setup.
- MCP endpoint configuration or server installation.
- Provider config key declarations.
- Instructions to repair sandbox package installation from within a normal user workflow.
- Harness-internal tool dispatcher names or active-tool catalog tags.

## Review checklist

- Directory name equals frontmatter `name`.
- Description triggers only the intended Junior extension work.
- Body is compact.
- Runtime authority belongs to a parent plugin when needed.
- All linked bundled files exist.
- The body has instructions after frontmatter.
