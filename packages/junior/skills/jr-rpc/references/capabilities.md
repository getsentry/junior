# Config guidance

Use the exact config-key names exposed by runtime context:

- loaded skill `uses-config`
- `<providers>` catalog in the prompt

Examples:

- `jr-rpc config set <config-key> <value>`

Rules:

- For normal authenticated operations, run the real provider command under the loaded skill and let the runtime inject credentials automatically.
- Declare config usage in the consuming skill's `uses-config` frontmatter.
- Do not guess config-key names; choose them from the loaded skill or provider catalog.
