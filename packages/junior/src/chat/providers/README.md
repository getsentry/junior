# Chat Providers

Provider layers add source-specific input, policy, progress, delivery, and
error behavior around the native agent runtime.

Each provider has a concrete directory. Do not add a provider registry or a
generic adapter framework. A provider may call provider-neutral runtime
contracts. The native runtime must not import a provider layer.

`slack/` owns Slack Turn routing and execution composition. Low-level Slack
transport, message projection, and formatting remain in `../slack/`.
