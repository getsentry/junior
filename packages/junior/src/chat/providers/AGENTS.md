# Chat Providers

Provider layers add source-specific input, policy, progress, delivery, and
errors around the native runtime.

- Each provider has its own directory, such as `slack/`. Do not add a provider
  registry or a generic adapter framework.
- A provider may call provider-neutral runtime contracts. `../runtime/` must
  not import a provider layer.
- Low-level Slack transport, message projection, and formatting stay in
  `../slack/`.
