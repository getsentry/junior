---
title: MCP Server
description: Connect Claude Code and other MCP clients to Junior at /api/mcp.
type: tutorial
summary: Connect an MCP client to the remote Junior MCP server, sign in with Google, and read and work with your Conversations, Review items, and Automations.
prerequisites:
  - /operate/dashboard/
related:
  - /concepts/conversations/
  - /reference/handler-surface/
  - /operate/security-hardening/
---

Junior has a remote MCP server at `/api/mcp`. An MCP client, such as Claude Code, can use it to read your Junior Conversations, Review items, and Automations. The client signs in through your Junior dashboard with Google. It can see only the Conversations that you started or take part in.

Only the `conversations:write` scope starts agent work. With it, a client can start a Conversation and send messages as you. No tool answers a Review item or runs an Automation.

## Before you start

- The app must mount the [dashboard](/operate/dashboard/) with Google sign-in required. When the dashboard is disabled, or `dashboard.authRequired` or `JUNIOR_DASHBOARD_AUTH_REQUIRED` is `false`, Junior does not mount `/api/mcp`.
- The app must know its public URL. Set `dashboard.baseURL` or `JUNIOR_BASE_URL`. On Vercel, Junior uses the production URL of the project when you do not set one. Preview deployments also use the production URL. To connect a client to a preview deployment, set `JUNIOR_BASE_URL` for that deployment.
- Your MCP client must support OAuth with Client ID Metadata Documents (CIMD). Junior does not support Dynamic Client Registration.

## Connect Claude Code

In the dashboard, open **Settings** and select **MCP**. The page shows the server URL, the Claude Code command, and a JSON config for other clients.

Add Junior as an HTTP MCP server:

```bash
claude mcp add --transport http junior https://<your-domain>/api/mcp
```

Start Claude Code, run `/mcp`, select `junior`, and select **Authenticate**. Claude Code opens your browser.

1. Sign in with Google if the dashboard asks you to.
2. Read the consent page. It shows the client name, the host that publishes the client (for example `claude.ai`), and each scope that the client asks for.
3. Select **Allow** only if you started this connection.

The browser returns to Claude Code, and the server shows as connected.

## Verify

Ask Claude Code to list your Junior Conversations:

```text
Use the junior MCP server to list my conversations.
```

Claude Code calls the `searchConversations` tool. The result shows up to 50 Conversations, newest activity first. Each one has its title, status, location, timestamps, and a dashboard link when the dashboard URL is known.

Then ask for one Conversation:

```text
Use junior to summarize my latest conversation.
```

Claude Code calls `getConversation`. It returns the Brief and the last assistant reply, not the full transcript.

You can also check discovery without a client:

```bash
curl -i https://<your-domain>/api/mcp -X POST
curl https://<your-domain>/.well-known/oauth-protected-resource/api/mcp
```

The first request returns `401` with a `WWW-Authenticate` header. The second request returns the resource metadata, with every scope in `scopes_supported`.

## Scopes and tools

A client gets only the tools of the scopes that you allow. A client that does not ask for a scope asks for all of them.

| Scope                  | Tools                                                                                                                                                                  | Effect                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `conversations:read`   | `searchConversations`, `getConversation`, `listConversationMessages`                                                                                                   | Read the Conversations that you started or take part in.                                                                     |
| `conversations:manage` | `archiveConversation`, `archiveDoneConversations`, `pinConversation`, `setConversationAutoArchive`, `markConversationRead`, `stopConversation`, `cancelQueuedMessages` | Archive, pin, or mark a Conversation read for you, set its auto-archive, stop its running Turn, or drop its queued messages. |
| `conversations:write`  | `createConversation`, `sendMessage`                                                                                                                                    | Start a Conversation or send a message as you. Junior starts a Turn for it.                                                  |
| `review_items:read`    | `searchReviewItems`, `getReviewItem`                                                                                                                                   | Read the Review items that you can see on the Review desk.                                                                   |
| `automations:read`     | `searchAutomations`, `getAutomation`                                                                                                                                   | Read the Automations that you can see, and their runs.                                                                       |

`getConversation` returns metadata, the Brief, the last assistant reply, and the messages that no Turn has read yet. When a Turn waits for you to connect an account, it also returns the authorization link. Pass a `cursor` as `after` to get the messages after that point instead of the last reply. Each result has a new `cursor`. `listConversationMessages` returns the user and assistant messages, newest last, 10 at a time by default. Pass its `nextCursor` as `before` to read older messages. Tool calls are not included.

Archive, pin, auto-archive, and read position apply only to you. `archiveDoneConversations` archives your done Conversations once, the same as **Archive done now** in Settings. `markConversationRead` marks every message read when you omit `lastReadSeq`.

`createConversation` starts a private Conversation by default. `createConversation` and `sendMessage` return when Junior accepts the message, not when Junior answers. Both return the messages that no Turn has read yet. A message sent while a Turn runs waits for that Turn. Your message has the same `messageId` in these results and in the transcript. To read the reply, call `getConversation` with `after` set to the returned `cursor`. Call it again with the newest `cursor` until `status` is not `active`. To retry a send without sending the message twice, pass the same `idempotencyKey`.

`stopConversation` stops the running Turn and drops the messages that wait for it. `cancelQueuedMessages` drops the waiting messages and lets the running Turn continue. Neither tool starts a new Turn. Review item and Automation results include a dashboard link. Answer a Review item or change an Automation there.

## Access and tokens

- A connection keeps the scopes that you allowed. To change them, connect the client again.
- Access tokens last 1 hour. Your client refreshes them for you. Each refresh token works once.
- A connection ends 30 days after you allow it, even when the client refreshes its tokens. Then connect the client again.
- Each request checks the [allowed domains](/reference/config-and-env/#allowed-domains) again. If your domain is removed, the connection stops working.
- Personal tokens do not work on `/api/mcp`. Only tokens from this OAuth flow work.

## Troubleshooting

| Symptom                              | Cause and fix                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `404` on `/api/mcp`                  | The dashboard is disabled, or it does not require sign-in. Configure the [dashboard](/operate/dashboard/) with sign-in required.                    |
| "This app cannot connect"            | The client did not send a valid CIMD client ID, or its redirect URI is not in its metadata document. Update the client, or use another client.      |
| "This sign-in request expired"       | The request is older than 10 minutes or was already used. Start the connection again from the client.                                               |
| The client asks you to connect again | The connection reached its 30-day limit, or Junior revoked it. Authenticate again.                                                                  |
| A tool is missing from the client    | The connection does not have the scope of that tool. Connections made before a scope existed do not get it. Authenticate again and allow the scope. |

## Next step

Read [Conversations](/concepts/conversations/) to learn which Conversations you can see and why.
