# Agent Dispatch

This feature turns an idempotent task or plugin dispatch into normal
conversation work. It owns dispatch authority and the plugin-facing status projection. The
conversation worker owns leases, retries, execution slices, and recovery; the
shared turn runtime owns agent execution and durable turn outcomes; the Slack
adapter owns destination delivery.

## Durable Facts

- The dispatch record is the durable request and status projection.
- The conversation mailbox contains a deferred inbound message that identifies
  the dispatch. Queue payloads only wake the conversation.
- The session record is authoritative for the active turn, resume state,
  accepted delivery receipt, and explicit terminal dispatch outcome.
- A dispatch uses one isolated conversation and one stable turn across all runs
  and execution slices.

The mailbox carries no credential authority. The first Run reads Actor,
credential subject, Source, Destination, and plugin metadata from the dispatch
record. The Turn saves Actor for later Runs. The dispatch record remains the
authority for the other facts until their owning contract changes.

## Identity Dispatch

A plugin webhook route can start private work for one person with
`ctx.agent.dispatchForIdentity`. The plugin gives the provider account id of
that person. Core uses the plugin name as the provider. A plugin cannot name an
Identity of another provider.

Core starts work only when all of these rules are true:

1. Junior has a Slack bot, and Slack `auth.test` gives the bot team id.
2. The provider is not a core Identity namespace (`junior` or `slack`).
3. One Identity has this provider, an empty tenant, this exact account id,
   kind `user`, and a linked user.
4. That user has exactly one Slack Identity in the bot team.
5. Slack `users.info` shows that Slack user in the bot team. The user is not
   deleted and is not a bot.
6. The email of that Slack profile is on the allowed domains, the same rule as
   Slack ingress. An empty list allows every domain.

If one rule is false, core returns `not_linked`. It starts no work and calls no
model. Missing Slack setup also returns `not_linked`, because core cannot find
a current Slack member. Other lookup and storage errors propagate to the route.

When all rules are true, core opens the bot DM with that Slack user. It then
creates a normal plugin dispatch to the DM with `private` visibility. The
dispatch has the `private-direct-conversation` credential subject for that
Slack user. Core binds and checks this subject with the same code as heartbeat
dispatches. The idempotency key has the same scope as other dispatches of that
plugin.

Only identities that the OAuth account-linking flow linked count. Provider
handles, emails from content, and display names never start this work.

## Conversation Title

A dispatched run has no human message. The run input is a bot-authored user
message, so the shared title generator uses it as the title source. The title
is set once, the same as for other Conversations.

- Until the generated title exists, the conversation API returns the name of
  the linked source Automation. When the API cannot find that Automation, it
  returns "Automation run". The API does not store this fallback.
- If generation fails, the title stays unset and the API keeps that fallback.
  A later transcript write tries generation again.

## Lifecycle

1. Core task or plugin heartbeat code creates the dispatch idempotently.
2. The dispatch is indexed before its mailbox append so heartbeat recovery can
   repair a crash between those writes.
3. The conversation worker validates dispatch identity and destination before
   starting or resuming the turn.
4. Durable `running` and `awaiting_resume` sessions resume even when the
   original mailbox item is redelivered.
5. Explicit session outcomes project to `completed`, `blocked`, or `failed`.
   A failed session without an explicit dispatch outcome remains retryable; the
   queue's final attempt owns terminal failure.
6. An accepted destination message is a delivery fence and must never be
   generated again during projection recovery.

Dispatch state transitions use a short dispatch lock while the conversation
lease is already held. Dispatch code never waits for a conversation lease while
holding that lock.

## Boundaries

- `context.ts` exposes the authorized core and plugin dispatch entry points,
  which include Identity dispatch for plugin routes.
- `store.ts` owns dispatch records, projections, and mailbox-append recovery
  receipts.
- `work.ts` adapts dispatches to conversation work and projects durable turn
  results.
- `heartbeat.ts` repairs incomplete mailbox appends before running plugin
  heartbeat hooks.
- `slack/dispatch-turn.ts` owns Slack message/thread adaptation and receives
  only dispatch-owned contracts.

Representative behavior coverage lives in
`tests/integration/agent-dispatch-work.test.ts`; local transition and authority
contracts live in `tests/component/agent-dispatch-worker.test.ts`. Identity
dispatch coverage lives in `tests/integration/identity-dispatch.test.ts`.
