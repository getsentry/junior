# Remote ACP Prototype

## Why

Junior cannot accept Agent Client Protocol (ACP) sessions from an external
client. Issue [#1525](https://github.com/getsentry/junior/issues/1525) asks for
a hosted agent endpoint for clients such as T3 Code and Zed.

Current T3 Code and Zed ACP paths start a local process. They do not provide a
remote acceptance client yet. A standard ACP Streamable HTTP endpoint gives
those clients a direct remote target when they add URL support. It also lets us
test the hosted Junior model now with the official ACP client.

The first experiment must stay small. It must not add a Junior stdio mode, an
agent registry, or a client workspace bridge.

## What Changes

- Add an opt-in ACP v1 Streamable HTTP endpoint at `/api/acp`.
- Authenticate each ACP HTTP request with an existing Junior personal token.
- Bind each ACP connection and session to the authenticated Actor.
- Map each ACP session to one private Junior Conversation.
- Send text prompts through the existing API Turn mailbox with
  `publishExternally: false`.
- Send durable assistant Messages as ACP session updates and finish the matching
  prompt after its Turn ends.
- Support `session/load` so a new connection can replay a Conversation and
  continue it.
- Add a protocol integration test and a small official-SDK smoke client for a
  local Junior process exposed through the existing Cloudflare tunnel.
- State the prototype limits. It does not support active Turn cancellation or
  multi-process Streamable HTTP state.

## Capabilities

### New Capabilities

- `remote-acp-agent`: Expose Junior as an authenticated remote ACP agent for the
  text prompt and reconnect happy path.

### Modified Capabilities

None.

## Impact

- `packages/junior` gains the ACP SDK dependency and a small ACP adapter.
- `createApp()` gains an `experimental.acp` opt-in and app-scoped ACP transport
  state.
- The existing API Turn and Conversation event paths remain the execution and
  reporting owners.
- The change adds no second authentication store, Conversation store, worker,
  event projection, or Message replay model.
- The prototype needs no database migration and no distributed transport store.
- The supported test deployment is one Node process. Production Vercel support
  is not part of this change.
