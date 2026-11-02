# Dashboard

- The dashboard changes no conversation state. Signed-in users can change
  only their own profile fields.
- Store no state except auth sessions and profile settings.
- Check access to private conversations on the server. Hidden client routes
  are not authorization. Check access before a detail `304`.
- The server turns runtime events into privacy-safe reporting events before
  they reach the client.
- Routes fail closed when identity or required configuration is missing.
- Mock reporting data is for local UI work only, never a production fallback.
- No service worker or offline cache.
- Read the mailbox before history and publish both in one render. Workers
  commit input before they acknowledge it, so input never disappears.
- A local send stays visible until a server snapshot has its Message id. The
  browser and web ingress share one Message id function.
- Only Turn lifecycle events turn on the thinking indicator. Queued work is
  not thinking.
- Paginated event reads never write into the cache of another resource.
- Display text keeps Markdown and Slack tokens. Do not resolve names in the
  dashboard (the API returns `mentions`) or rewrite tokens on the server.
- `oxlint/display-text.ts` matches on field names. Do not name a field `text`,
  `body`, or `summary` when it is not display text.
- Import Shiki grammars on demand through `client/code-languages.ts`, never
  the full bundle.
- Do not call cache input shares a cache hit or failure rate.
- Each user-facing page has one `e2e/` spec. Specs import `test` from
  `./test` and call `screenshot(page, name)` after load.
- Mocks and browser tests use one fixed time, `NOW`.

UI rules: `src/client/components/AGENTS.md`.
