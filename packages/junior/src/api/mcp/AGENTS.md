# Remote MCP

- This is the MCP server. `src/chat/mcp/` is the client for plugin MCP
  servers. Do not mix the two.
- `listConversations` relies on the membership guarantee of
  `readConversationFeed`. Never pass `codeRepositoryId` or `actorEmail`.
  Every other conversation tool checks `isConversationParticipant` first.
- No tool sends a message, answers or dismisses a Review item, or starts a
  Turn or an Automation run. A Review item action sends a message to its
  Conversations, so Review items stay read-only.
- Each scope in `oauth/scopes.ts` unlocks the tools in `TOOLS_BY_SCOPE`. A
  client sees only the tools of its granted scopes. A grant stores its
  scopes as one space-separated value. Refresh never changes it.
- Keep OAuth records in the `StateAdapter` with a TTL. No table.
- Clients identify only with Client ID Metadata Documents (CIMD). No client
  registration.
- Store only SHA-256 hashes of codes, tokens, and consent form tokens.
- An invalid `client_id` or redirect URI gets an HTML `400`. Never redirect to
  an unchecked URI.
- A CIMD fetch connects only to public addresses on its own socket and does
  not follow redirects. Cache failed fetches, because authorize needs no
  sign-in.
- PKCE `S256` is required. The `resource` must be the exact `/api/mcp` URL.
- The first signed-in user who opens a consent page owns it. Approve and deny
  need a same-origin `POST` with that user's newest form token.
- A refresh token reuse inside the rotation grace window gets `invalid_grant`
  and keeps the grant.
