# Capability guidance

Use the exact capability and config-key names exposed by runtime context:

- loaded skill `requires-capabilities`
- loaded skill `uses-config`
- provider-capabilities catalog in the prompt

Examples:

- `jr-rpc issue-credential <capability>`
- `jr-rpc issue-credential <capability> --repo owner/repo`
- `jr-rpc config set <config-key> <value>`

Scoping rules:

- Repo-targeted capabilities require `--repo <owner/repo>` unless the provider already has a configured default repository key.
- Capabilities without repo targets do not use `--repo`.
- Declare capabilities in the consuming skill's `requires-capabilities` frontmatter. Currently soft-enforced (warn-only).
- Do not guess capability or config-key names; choose them from the loaded skill or provider catalog.
