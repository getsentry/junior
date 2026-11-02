# Remote MCP

Server side of MCP at `/api/mcp`, per the
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
`src/chat/mcp/` is the client side for plugin MCP servers. Do not mix them.

## Boundaries

- The app mounts the MCP routes and consent page only when
  `dashboardRequiresSignIn` returns true. Consent needs a Google-signed-in
  Junior user.
- `listConversations` relies on the membership guarantee of
  `readConversationFeed`. MCP never passes `codeRepositoryId` or
  `actorEmail`.
- OAuth records live in the `StateAdapter` with a TTL. No table.
- The route is stateless. Each `POST` gets a new server.

## Security Invariants

- Clients identify only with Client ID Metadata Documents (CIMD). No client
  registration.
- Store only SHA-256 hashes of codes, tokens, and consent form tokens.
- An invalid `client_id` or redirect URI gets an HTML `400`. Never redirect to
  an unchecked URI.
- A CIMD fetch connects only to public addresses on its own socket and does
  not follow redirects. Failed fetches are cached, because authorize needs no
  sign-in.
- PKCE `S256` is required. The only scope is `conversations:read`. The
  `resource` must be the exact `/api/mcp` URL.
- The first signed-in user who opens a consent page owns it. Approve and deny
  need a same-origin `POST` with that user's newest form token.
- A code works once. A second use revokes the grant.
- A refresh token works once. A reuse inside the rotation grace window gets
  `invalid_grant` and keeps the grant. A later reuse revokes it.
- A grant ends 30 days after consent. Refresh does not extend it.
- Each request checks the grant email with `isAllowedSignInEmail` and
  `resolveViewerUser`, so a removed domain stops a grant.
- `/api/mcp` accepts only MCP access tokens for this resource. Personal tokens
  and dashboard sessions get `401`.
