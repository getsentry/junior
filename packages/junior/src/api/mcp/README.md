# Remote MCP

Junior exposes a remote MCP server at `/api/mcp`. The server uses MCP
Streamable HTTP. It has one tool, `listConversations`. The tool lists the
Conversations of the signed-in user.

The app mounts the MCP routes only when the dashboard requires Google sign-in.
Consent needs a signed-in Junior user. When `dashboard.authRequired` or
`JUNIOR_DASHBOARD_AUTH_REQUIRED` is `false`, the dashboard serves a local viewer
without sign-in. Then the MCP routes and the consent page do not exist.
`dashboardRequiresSignIn` in `src/dashboard-routes.ts` owns this rule. Core
passes its result to the dashboard app, so both use the same value.

## Ownership

This directory owns the MCP HTTP edge, the OAuth authorization server for MCP,
and the MCP tool. It does not own Conversation access rules.
`listConversations` calls `readConversationFeed({ viewer })` in
`@/api/conversations/list`. That function applies the access rules.

This directory is the server side of MCP. `src/chat/mcp/` is the client side,
which connects Junior to plugin MCP servers. Do not mix the two.

| File                 | Owns                                                      |
| -------------------- | --------------------------------------------------------- |
| `route.ts`           | Paths, bearer check, and the `401` challenge              |
| `metadata.ts`        | Paths, the scope, public URLs, and discovery documents    |
| `client-metadata.ts` | CIMD client ID rules, document fetch, and redirect match  |
| `public-address.ts`  | The public-address rule for CIMD fetches                  |
| `authorization.ts`   | `GET /api/mcp/oauth/authorize` and pending authorizations |
| `consent-page.ts`    | The dashboard consent page and its form checks            |
| `grants.ts`          | Authorization codes, access tokens, and refresh tokens    |
| `token.ts`           | `POST /api/mcp/oauth/token`                               |
| `server.ts`          | The MCP server, its transport, and `listConversations`    |
| `state.ts`           | State keys for MCP records                                |

## Request Flow

1. A client sends a request to `/api/mcp` without a token. Junior returns `401`
   with `WWW-Authenticate: Bearer resource_metadata="<url>"`.
2. The client reads the protected resource metadata (RFC 9728) and the
   authorization server metadata (RFC 8414).
3. The client opens `/api/mcp/oauth/authorize` in a browser. Junior fetches the
   client metadata document and checks the request.
4. Junior sends the browser to the consent page at
   `/_junior/mcp/authorize/:requestId`. The dashboard requires Google sign-in
   for this page.
5. The user allows access. Junior redirects to the client with a code.
6. The client exchanges the code at `/api/mcp/oauth/token`. It gets an access
   token and a refresh token.
7. The client calls `/api/mcp` with the access token.

## Design

Clients identify themselves only with Client ID Metadata Documents (CIMD). The
`client_id` is an HTTPS URL. The document at that URL gives the client name and
its redirect URIs. Junior has no Dynamic Client Registration and no
`registration_endpoint`. Junior has no other client model.

All OAuth records are in the Junior `StateAdapter`. Production uses Redis. Each
record has a TTL. Any app instance can handle any request. There is no
database table.

| Record                | TTL               |
| --------------------- | ----------------- |
| Client document cache | 5 minutes         |
| Failed client fetch   | 1 minute          |
| Pending authorization | 10 minutes        |
| Authorization code    | 60 seconds        |
| Access token          | 1 hour            |
| Grant                 | 30 days           |
| Refresh token         | Rest of the grant |

A grant ends 30 days after consent. Refresh does not extend it, and no token
lives longer than its grant. Then the user must connect the client again.
Personal tokens last 90 days. A grant is shorter, because a third-party client
holds its tokens and no page can revoke a grant yet.

A grant stores the user email, not a copy of the user. Each MCP request checks
the email against the allowed domains with `isAllowedSignInEmail`, the check
that the dashboard uses. Then it resolves the user with `resolveViewerUser`.
Thus a removed domain stops a grant at the next request.

The MCP route is stateless. Each `POST` creates a new MCP server and a new
transport that answers with JSON. No MCP session or SSE stream stays open
after the request. Thus the route does not reach the live request limit of the
deployment. `GET` and `DELETE` return `405`, because there is no session to
stream or delete.

## Invariants

- Junior stores only SHA-256 hashes of codes, tokens, and consent form tokens.
- A `client_id` must be an `https:` URL with a path, without a fragment, and
  without credentials. For other values, the authorize endpoint shows an HTML
  error page with status `400`. It does not redirect.
- A CIMD fetch does not follow redirects. It has a 5 second timeout and a 5 KB
  limit. It connects only to public addresses. The check runs on each DNS
  answer when the socket connects. Each fetch opens a new socket, because a
  pooled socket does not run the check.
- The authorize endpoint needs no sign-in, and it fetches URLs. Thus Junior
  caches a failed fetch for 1 minute for each `client_id`.
- The document `client_id` must equal the requested URL exactly. The document
  must not ask for client authentication.
- A redirect URI must equal a registered URI. A loopback `http:` URI can use any
  port (RFC 8252 section 7.3).
- When the client or the redirect URI is not valid, Junior shows an error page.
  It never redirects to an unchecked URI.
- PKCE with `S256` is required. The only scope is `conversations:read`. The
  `resource` must be the exact `/api/mcp` URL (RFC 8707).
- The first signed-in user who opens a consent page owns it. Approve and deny
  need a same-origin `POST` with the form token of that user.
- One consent gives one code. A code works once. A second use of a code
  revokes the grant that the first use made.
- A refresh token works once. Each refresh gives a new token pair. A client
  that runs in many processes can refresh one token at the same time. Thus a
  second use within 60 seconds of the rotation gets `invalid_grant`, and the
  grant stays. A later second use revokes the grant and all of its tokens.
- A revoked grant gets a marker that lives for 30 days, the longest grant
  lifetime. A request that saves the grant again in a race cannot restore it.
  Junior logs `mcp.oauth.grant.revoked` with the client ID and the reason.
- `/api/mcp` accepts only MCP access tokens for this exact resource. Personal
  tokens and dashboard sessions get `401`.
- The tool output has its own schema. It does not expose dashboard-only fields.

## Tests

`tests/integration/api/mcp/route.test.ts` runs the full flow through the real
app. It uses the official MCP SDK client and a fake CIMD host from
`tests/msw/handlers/mcp-client-metadata.ts`. Unit tests cover only the
public-address rule and loopback redirect match.
