# Remote ACP

Junior exposes ACP v1 Streamable HTTP at `/api/acp` when the app sets
`experimental: { acp: true }`. The route accepts `GET`, `POST`, and `DELETE`.
Every request needs a Junior personal token in an `Authorization: Bearer`
header.

The adapter maps an ACP session to a private Conversation. It uses the existing
web Actor, API Turn mailbox, worker, event store, and Conversation access rules.
Client paths do not select the Junior sandbox. Client MCP servers, resource
links, media, filesystem callbacks, terminal callbacks, and active Turn
cancellation are not supported.

The ACP SDK keeps connection state in the Node process. This prototype supports
one process only. Do not use it on a multi-process deployment until the
transport has proven affinity or the SDK provides a released distributed state
backend. Direct tests with T3 Code or Zed, active Turn cancellation, and agreed
resource-link and tool behavior are also required before promotion.

Run the official-SDK smoke client against a single local process through the
existing tunnel:

```sh
JUNIOR_ACP_URL=https://example.trycloudflare.com/api/acp \
JUNIOR_ACP_TOKEN=jr_pat_example \
JUNIOR_ACP_FOLLOW_UP="Send one follow-up reply." \
pnpm --filter @sentry/junior acp:smoke
```

Set `JUNIOR_ACP_SESSION_ID` to load an earlier Conversation before the first
prompt. The client always reconnects once and loads the active session. It
prints the session id so it can be reused.

## Local Validation

Run `pnpm acp:local` from the repository root. The command starts the local
Postgres and Redis services, applies core migrations, and opens the real
`/api/acp` route on loopback. It creates a short-lived test token, runs the
official SDK smoke client with two Turns and one reconnect, revokes the token,
and exits. The token does not enter terminal output. The test server uses the
normal auth, Conversation, mailbox, worker, event, and replay paths. It replaces
only Vercel Queue transport and model generation with in-process test adapters.

This command is test equipment. It does not add a local ACP transport to the
product. The Compose services stay available for later local tests.
