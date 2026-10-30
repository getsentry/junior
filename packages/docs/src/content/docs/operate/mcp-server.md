---
title: MCP Server
description: Connect Claude Code and other MCP clients to Junior at /api/mcp.
type: tutorial
summary: Connect an MCP client to the remote Junior MCP server, sign in with Google, and list your Conversations.
prerequisites:
  - /operate/dashboard/
related:
  - /concepts/conversations/
  - /reference/handler-surface/
  - /operate/security-hardening/
---

Junior has a remote MCP server at `/api/mcp`. An MCP client, such as Claude Code, can use it to list your Junior Conversations. The client signs in through your Junior dashboard with Google. It can see only the Conversations that you started or take part in.

## Before you start

- The app must mount the [dashboard](/operate/dashboard/) with Google sign-in. Without it, Junior does not mount `/api/mcp`.
- The app must know its public URL. Set `dashboard.baseURL` or `JUNIOR_BASE_URL`. On Vercel, Junior uses the production URL of the project when you do not set one.
- Your MCP client must support OAuth with Client ID Metadata Documents (CIMD). Junior does not support Dynamic Client Registration.

## Connect Claude Code

Add Junior as an HTTP MCP server:

```bash
claude mcp add --transport http junior https://<your-domain>/api/mcp
```

Start Claude Code, run `/mcp`, select `junior`, and select **Authenticate**. Claude Code opens your browser.

1. Sign in with Google if the dashboard asks you to.
2. Read the consent page. It shows the client name and the host that publishes the client, for example `claude.ai`.
3. Select **Allow** only if you started this connection.

The browser returns to Claude Code, and the server shows as connected.

## Verify

Ask Claude Code to list your Junior Conversations:

```text
Use the junior MCP server to list my conversations.
```

Claude Code calls the `listConversations` tool. The result shows up to 50 Conversations, newest activity first. Each one has its title, status, location, timestamps, and a dashboard link when the dashboard URL is known.

You can also check discovery without a client:

```bash
curl -i https://<your-domain>/api/mcp -X POST
curl https://<your-domain>/.well-known/oauth-protected-resource/api/mcp
```

The first request returns `401` with a `WWW-Authenticate` header. The second request returns the resource metadata, with the `conversations:read` scope.

## The `listConversations` tool

| Input    | Type                       | Effect                                                                                          |
| -------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| `q`      | string                     | Search titles and Briefs. A search ignores `status`.                                            |
| `status` | `"active"` or `"archived"` | List Conversations that you have not archived (the default), or the Conversations you archived. |

The tool is read-only. It has no pagination.

## Access and tokens

- The only scope is `conversations:read`.
- Access tokens last 1 hour. Refresh tokens last 30 days, and each one works once. Your client refreshes them for you.
- If someone uses an old refresh token again, Junior revokes the whole connection. Connect the client again.
- Personal tokens do not work on `/api/mcp`. Only tokens from this OAuth flow work.

## Troubleshooting

| Symptom                              | Cause and fix                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `404` on `/api/mcp`                  | The dashboard or its Google sign-in is not configured. Configure the [dashboard](/operate/dashboard/).                                         |
| "This app cannot connect"            | The client did not send a valid CIMD client ID, or its redirect URI is not in its metadata document. Update the client, or use another client. |
| "This sign-in request expired"       | The request is older than 10 minutes or was already used. Start the connection again from the client.                                          |
| The client asks you to connect again | The refresh token expired or Junior revoked the connection. Authenticate again.                                                                |

## Next step

Read [Conversations](/concepts/conversations/) to learn which Conversations you can see and why.
