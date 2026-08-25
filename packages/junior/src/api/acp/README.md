# Remote ACP

Every Junior app exposes ACP v1 Streamable HTTP at `/api/acp`. The route accepts
`GET`, `POST`, and `DELETE`. No app option enables it. The app must configure the
dashboard before a client can authenticate. The client must support ACP URL
elicitation. Junior then advertises browser sign-in as its ACP authentication
method. The dashboard completes Google OAuth and binds the verified Junior user
to the ACP connection after the user enters the verification code shown by the
client. Personal tokens do not grant ACP access.

ACP maps a session to a private Conversation. It uses the existing
web Actor, API Turn mailbox, worker, event store, and Conversation access rules.
Client paths do not select the Junior sandbox. Client MCP servers, resource
links, media, filesystem callbacks, and terminal callbacks are not supported.
`session/cancel` stops the active Turn and returns the ACP `cancelled` stop
reason.

## Ownership

This directory owns ACP JSON-RPC, SSE, connection state, browser authorization,
and its direct Conversation calls. `conversations.ts` uses Junior's existing
access, mailbox admission, cancellation, queue, and event projection code. No
general adapter or plugin contract sits between ACP and the runtime. No ACP type
enters the agent loop.

## Runtime Design

The ACP `sessionId` is the Junior `conversationId`. The Conversation remains
the source for history, Turn state, and replay. The normal mailbox, queue,
lease, checkpoint, and event paths run the work.

The ACP transport stores hashed connection credentials, browser authorization
transactions, retry receipts, pending stream items, stream cursors, and stream
leases in the Junior `StateAdapter`.
Production uses the existing Redis adapter. Any ACP request can reach any app
instance. The route does not need process affinity or a separate ACP service.
The memory adapter remains process-local and is suitable only for local use.
Each stream preserves up to 1,024 undelivered items. It returns `503` instead
of dropping an item when that limit is full.

Junior admits a prompt only while the Conversation has no runnable work. The
Conversation mutation lock protects this check and the mailbox append. This
prevents retryable work from overlapping a follow-up.

## Live HTTP Limit

ACP v1 delivers server messages over live SSE requests. The official client
opens one connection stream and one stream for each active session. Junior can
restore a Conversation after either stream disconnects, but ACP v1 does not
replay an in-flight transport response on a new connection.

`juniorNitro()` sets the default Vercel function duration to 300 seconds. A
client must create a new ACP connection and call `session/load` after a live
stream reaches that limit. Junior keeps running accepted work after a client
disconnects, and a later load replays its stored Messages. A prompt that is
still in flight when the stream closes cannot resolve transparently in the old
client connection.

ACP remains a pre-stable surface. Test client-specific session, resource, and
tool behavior before relying on it for general use.

Run the official-SDK smoke client against a single local process through the
existing tunnel:

```sh
JUNIOR_ACP_URL=https://example.trycloudflare.com/api/acp \
JUNIOR_ACP_FOLLOW_UP="Send one follow-up reply." \
pnpm --filter @sentry/junior acp:smoke
```

The client prints a one-time sign-in URL and verification code. Open the URL,
enter the code, and finish Google sign-in. The app must mount the authenticated
dashboard. Its Google OAuth client must allow the app's
`/api/auth/callback/google` URL.

Set `JUNIOR_ACP_SESSION_ID` to load an earlier Conversation before the first
prompt. The client always reconnects once and loads the active session. It
prints the session id so it can be reused.

## Local Validation

Run `pnpm acp:local` from the repository root. The command starts the local
Postgres and Redis services, applies core migrations, and opens the real
`/api/acp` route on loopback. It runs the official SDK smoke client with two
Turns and one reconnect, and then exits. A local callback route completes
the same ACP authorization transaction without Google. The test server uses
the normal Conversation, mailbox, worker, event, and replay paths. It replaces
only Google sign-in, Vercel Queue transport, and model generation with local
test fakes.

This command is test equipment. It does not add a local ACP transport to the
product. The Compose services stay available for later local tests.
