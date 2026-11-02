# Chat Runtime

- The native runtime must not import a provider layer. Low-level provider
  adapters must not orchestrate Turns.
- Runtime and service modules use small injected ports, never provider
  implementations or the production singleton.
- Verify Slack authors before storage, routing, or reactions
  (`ingress/workspace-membership.ts`). Event delivery does not prove
  membership.
- Keep Source, Actor, Location, and Delivery separate: no shared type, routing
  object, or wrapper. The work owner supplies Delivery before each new or
  resumed Run. Source, Actor, and Location do not select it.
- Attribution does not grant authority. Credentials need the current Actor or
  an explicit delegated credential subject.
- Only `<current-instruction>` authorizes work. Request context, such as
  plugin context and Conversation notes, is true only for its own Turn.
- Commit durable state before you acknowledge queue work or yield.
- Tool registration depends on the Conversation, not the Turn. To block a tool
  for one Turn, set `disabledReason` with `disableTools`. Do not remove it or
  put Turn text in its description or schema; this keeps the provider cache.
- Prompt, tools, and Delivery read `dispatch.declaresResult`. They do not
  check the Source.
- Progress uses the status surface, never an assistant reply. `no_reply`
  needs an intentional no-reply. Missing text is not silence.
