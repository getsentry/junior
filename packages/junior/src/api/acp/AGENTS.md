# Remote ACP

Owns the pre-stable ACP v1 Streamable HTTP route at `/api/acp`: JSON-RPC, SSE,
connection state, browser authorization, and the Conversation calls in
`conversations.ts`. It reuses the web Actor, mailbox, Turn worker, event
store, and Conversation access rules. It does not own Conversations or Turns.

## Boundaries

- No adapter or plugin contract sits between ACP and the runtime. No ACP type
  enters the agent loop.
- The ACP `sessionId` is the `conversationId`. An ACP session maps to a
  private Conversation, which stays the source for history, Turn state, and
  replay.
- Client paths do not select the Junior Sandbox. Prompt resource links are
  stored as text. Junior never fetches their URIs.
- Not supported: client MCP servers, embedded resources, media, filesystem
  callbacks, and terminal callbacks.
- Only dashboard browser sign-in grants access, and the client must support
  ACP URL elicitation. Personal tokens do not grant access.

## State And Delivery

- All transport state is in the `StateAdapter`, with hashed connection
  credentials. Any app instance serves any request. No process affinity or
  separate ACP service.
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
