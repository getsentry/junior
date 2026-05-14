# Config guidance

Use the exact config-key names exposed by runtime context:

- `<providers>` catalog in the prompt

Examples:

- `jr-rpc config set <config-key> <value>`

Rules:

- For normal authenticated operations, run the real provider command and let the runtime inject credentials automatically when requests reach registered provider domains.
- Do not guess config-key names; choose them from the provider catalog.
