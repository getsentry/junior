# Remote ACP

This directory owns the ACP v1 Streamable HTTP route at `/api/acp`: JSON-RPC,
SSE, connection state, browser authorization, and its direct Conversation
calls in `conversations.ts`. ACP is a pre-stable surface.

It does not own Conversations or Turns. It uses the existing web Actor,
mailbox, Turn worker, event store, and Conversation access rules.

## Boundaries

- No adapter or plugin contract sits between ACP and the runtime. No ACP type
  enters the agent loop.
- The ACP `sessionId` is the `conversationId`. The Conversation stays the
  source for history, Turn state, and replay.
- An ACP session maps to a private Conversation.
- Client paths do not select the Junior Sandbox. Junior stores prompt
  resource links as text and never fetches their URIs.
- Client MCP servers, embedded resources, media, filesystem callbacks, and
  terminal callbacks are not supported.

## Auth

- Only browser sign-in through the dashboard grants ACP access. The client
  must support ACP URL elicitation. Personal tokens do not grant ACP access.

## State And Delivery

- All transport state is in the `StateAdapter`, with hashed connection
  credentials. Any app instance can serve any request. Do not add process
  affinity or a separate ACP service.
- A full stream buffer returns `503`. It never drops an item.
- Junior accepts a prompt only while the Conversation has no runnable work.
  The Conversation mutation lock covers this check and the mailbox append.
- Accepted work keeps running after a client disconnects. A later
  `session/load` replays stored Messages. ACP v1 cannot replay an in-flight
  response on a new connection.

## Commands

| Task                         | Command                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Local end-to-end check       | `pnpm acp:local` (local fakes for Google, Vercel Queue, and model only)          |
| Smoke test through a tunnel  | `JUNIOR_ACP_URL=https://<tunnel>/api/acp pnpm --filter @sentry/junior acp:smoke` |
| Load an earlier Conversation | add `JUNIOR_ACP_SESSION_ID=<id>`                                                 |
