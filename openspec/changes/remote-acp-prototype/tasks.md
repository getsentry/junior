# Tasks

## 1. Experimental HTTP Route

- [x] 1.1 Add the supported `@agentclientprotocol/sdk` v1 package to
      `@sentry/junior` and update the pnpm lockfile.
- [x] 1.2 Add `acp` to the validated `createApp({ experimental })` keys and keep
      it off by default.
- [x] 1.3 Add an `api/acp` module that builds the ACP v1 Agent and Streamable
      HTTP route.
- [x] 1.4 Construct the ACP server and all connection state inside one
      `createApp()` call. Do not add a mutable module global.
- [x] 1.5 Mount `/api/acp` for `GET`, `POST`, and `DELETE` only when the flag is
      enabled. Return the SDK Web `Response` directly.

## 2. Authentication And Connection Ownership

- [x] 2.1 Parse a bearer token on every ACP request and call the existing
      `authenticatePersonalToken()` function.
- [x] 2.2 Resolve the token owner with `resolveViewerUser()` and
      `webActorFromEmail()` before ACP dispatch.
- [x] 2.3 Create each ACP Agent with the authenticated Actor and a random
      connection nonce.
- [x] 2.4 Bind each successful `Acp-Connection-Id` to its Actor in app-scoped
      state, check later requests, and remove the binding on `DELETE`.
- [x] 2.5 Keep ACP write authority in this route. Do not broaden personal-token
      writes for dashboard or plugin API routes.

## 3. Session And Conversation Mapping

- [x] 3.1 Export or refactor the existing API Turn activity function so it can
      record the empty private root for `session/new`. Do not add another
      Conversation creation implementation.
- [x] 3.2 Implement `initialize` with only the supported v1 and load
      capabilities.
- [x] 3.3 Implement `session/new` with `local:acp:<uuid>` as both Conversation id
      and ACP session id.
- [x] 3.4 Authorize `session/load` and `session/prompt` with
      `readConversationAccessFromSql()` before reading or writing private data.
- [x] 3.5 Treat `cwd` and additional directories as non-authoritative client
      context. Do not persist them or map them to Junior's sandbox.
- [x] 3.6 Reject non-empty client MCP server configuration and do not add
      filesystem or terminal callbacks.

## 4. Prompt And Output Bridge

- [x] 4.1 Accept ordered non-empty text blocks and reject all other prompt
      content before mailbox append.
- [x] 4.2 Build mailbox idempotency from the connection nonce and ACP request id,
      then call `appendAndEnqueueApiConversationMessage()`.
- [x] 4.3 Derive the matching Turn id from the accepted Message id and read
      canonical Conversation events with `ConversationEventStore.query()` in
      bounded forward `seq` pages. Use the existing abort-aware `sleep()` between
      empty reads. Do not add another event query, projection, or wait utility.
- [x] 4.4 Send each matching durable assistant Message as one awaited
      `agent_message_chunk` update.
- [x] 4.5 Resolve successful and no-reply Turns with `end_turn`, and map a failed
      Turn to a JSON-RPC error.
- [x] 4.6 Stop the event waiter when the ACP request signal ends. Do not claim
      that this cancels the durable Turn.
- [x] 4.7 Do not add a new runtime event bus or token-level streaming path.

## 5. Load And Replay

- [x] 5.1 Read authorized visible Conversation Messages with
      `loadMessageHistory()` and `projectConversationMessages()`.
- [x] 5.2 Implement `session/load` replay with user and assistant text chunk
      updates. Skip system Messages and internal agent history.
- [x] 5.3 Verify that a new initialized connection can load a session and enqueue
      another prompt in the same Conversation.

## 6. Integration Verification

- [x] 6.1 Extend the existing API Turn integration fixture for one scenario
      through the real Hono app and official ACP HTTP client. Reuse its real
      Conversation, mailbox, worker, and event wiring; fake only model output.
- [x] 6.2 Cover missing and invalid bearer tokens and a valid
      initialize-new-prompt-update-`end_turn` path.
- [x] 6.3 In that protocol scenario, assert once that ACP selects a private
      Conversation and `publishExternally: false`. Keep the detailed runtime
      behavior coverage in the existing API Turn tests.
- [x] 6.4 Cover a new connection, `session/load`, ordered replay, and another
      prompt.
- [x] 6.5 Cover cross-Actor connection and session rejection.
- [x] 6.6 Cover unsupported resource-link and other non-text prompt input, plus
      non-empty MCP server input, at the protocol boundary.
- [x] 6.7 Do not add an eval. These are deterministic transport and persistence
      contracts.

## 7. Manual Prototype

- [x] 7.1 Add a small official-SDK smoke client that reads the ACP URL and
      personal token from environment variables. Keep it as test equipment, not a
      product bridge.
- [x] 7.2 Opt the example app into `experimental.acp` on the prototype branch so
      `pnpm dev` exposes the route without changing the package default.
- [x] 7.3 Add a test-only `pnpm acp:local` command. Use local Postgres, Redis,
      the real app route, the API Turn test queue, and deterministic model output.
- [x] 7.4 Run the official SDK smoke client over loopback TCP. Verify two Turns,
      `end_turn`, reconnect, ordered load replay, private storage, and clean
      token revocation.
- [ ] 7.5 Run the smoke client against one local Node process through the
      existing Cloudflare tunnel. Record the session id and successful load path.
- [ ] 7.6 If useful, run one deployed affinity experiment and record the result.
      Do not add Redis, a custom transport backend, WebSocket, or retry machinery in
      this change.

## 8. Limits And Handoff

- [x] 8.1 Add a short `api/acp` README with the endpoint, opt-in, reused Junior
      owners, personal token use, client path limits, and single-process limit.
- [x] 8.2 Record active Turn cancellation, a production transport state model,
      and one direct T3 Code or Zed remote test as promotion gates.
- [x] 8.3 Run the focused integration test and applicable type and lint checks
      for `@sentry/junior`.
- [ ] 8.4 After the experiment is accepted or rejected, move durable decisions
      beside the owning code and remove this completed temporary plan.
