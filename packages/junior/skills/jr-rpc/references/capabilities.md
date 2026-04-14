# Capability guidance

Use the exact capability and config-key names exposed by runtime context:

- loaded skill `requires-capabilities`
- loaded skill `uses-config`
- provider-capabilities catalog in the prompt

Examples:

- `jr-rpc issue-credential <capability>`
- `jr-rpc issue-credential <capability> --target value`
- `jr-rpc config set <config-key> <value>`

Scoping rules:

- Provider-targeted capabilities require `--target <value>` unless the provider already has a configured default target key.
- Capabilities without provider targets do not use `--target`.
- Declare capabilities in the consuming skill's `requires-capabilities` frontmatter. Currently soft-enforced (warn-only).
- Do not guess capability or config-key names; choose them from the loaded skill or provider catalog.
