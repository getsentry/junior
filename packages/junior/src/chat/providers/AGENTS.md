# Chat Providers

Provider layers add source-specific input, policy, progress, delivery, and
errors around the native runtime.

- One directory per provider, such as `slack/`. No provider registry or
  generic adapter framework.
- `../runtime/` must not import a provider layer.
- Low-level Slack transport, message projection, and formatting stay in
  `../slack/`.
