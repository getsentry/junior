# Remote MCP

Junior exposes a remote MCP server at `/api/mcp`. The server uses MCP
Streamable HTTP. It has one tool, `listConversations`, which lists the
Conversations of the signed-in user. The OAuth flow follows the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

This directory is the server side of MCP. `src/chat/mcp/` is the client side,
which connects Junior to plugin MCP servers. Do not mix the two.

## Layout

`route.ts` mounts the HTTP routes and `server.ts` builds the MCP server.
`oauth/` has the OAuth authorization server. To add a tool, add one file under
`tools/` and call its register function in `server.ts`.

## Mount rule

Consent needs a Junior user who signed in with Google. Thus the app mounts the
MCP routes and the consent page only when `dashboardRequiresSignIn` returns
true. Without required sign-in, the dashboard serves a local viewer.

## Design

- Clients identify themselves only with Client ID Metadata Documents (CIMD).
  The `client_id` is an HTTPS URL. The document at that URL names the client
  and its redirect URIs. Junior has no client registration.
- `listConversations` calls `readConversationFeed({ viewer, q, status })`. The
  JSDoc of that function states the membership guarantee that MCP depends on:
  only Conversations that the viewer started or takes part in. MCP never passes
  `codeRepositoryId` or `actorEmail`.
- All OAuth records are in the `StateAdapter` with a TTL. There is no database
  table.
- A grant ends 30 days after consent. Refresh does not extend it. Personal
  tokens last 90 days. A grant is shorter, because a third-party client holds
  its tokens and no page can revoke a grant yet.
- A grant stores the user email. Each MCP request checks the email with
  `isAllowedSignInEmail` and resolves the user with `resolveViewerUser`, as the
  dashboard does. Thus a removed domain stops a grant at the next request.
- The MCP route is stateless. Each `POST` gets a new server and a transport
  that answers with JSON. `GET` and `DELETE` return `405`.

## Invariants

- Junior stores only SHA-256 hashes of codes, tokens, and consent form tokens.
- An invalid `client_id` or redirect URI gets an HTML `400` page. Junior never
  redirects to an unchecked URI.
- A CIMD fetch connects only to public addresses, on its own socket, and does
  not follow redirects. A failed fetch is cached for 1 minute, because the
  authorize endpoint needs no sign-in.
- PKCE with `S256` is required. The only scope is `conversations:read`. The
  `resource` must be the exact `/api/mcp` URL.
- The first signed-in user who opens a consent page owns it. Approve and deny
  need a same-origin `POST` with the newest form token of that user.
- One consent gives one code, and a code works once. A second use of a code
  revokes the grant.
- A refresh token works once. A client can run in many processes that refresh
  at the same time. Thus a second use within 60 seconds of the rotation gets
  `invalid_grant` and keeps the grant. A later second use revokes the grant.
- `/api/mcp` accepts only MCP access tokens for this exact resource. Personal
  tokens and dashboard sessions get `401`.
