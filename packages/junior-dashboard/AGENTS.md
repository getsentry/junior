# Dashboard

## Intent

- The dashboard is an authenticated reporting surface over Junior
  conversation read models. It does not take part in agent execution.
- It changes no conversation state. Signed-in users can change only their own
  profile fields.
- Junior conversation storage is the reporting authority. The package keeps
  no state except auth sessions and profile settings.
- `src/api/` schemas own the client/server boundary.

## Auth and privacy

- Core owns the Better Auth session. Routes fail closed when identity or
  required configuration is missing.
- Check access to private conversations on the server. Hidden client routes
  are not authorization.
- The server turns runtime events into privacy-safe reporting events
  (`policies/data-redaction.md`).
- Mock reporting data is for local UI work only, never a production fallback.
- The installable shell is static. No service worker or offline cache.

## Conversation detail

- Detail and mailbox share one TanStack Query snapshot. Read the mailbox
  first, then history, and publish both in one render. Workers commit input
  before they acknowledge it, so input never disappears in between.
- A local send stays visible until a server snapshot has its Message id. The
  browser and web ingress share one Message id function.
- Only Turn lifecycle events turn on the thinking indicator. Queued work is
  not thinking.
- Paginated event reads never write into the cache of another resource.
- Detail ETags save transfer and parsing only. Check access before a `304`.

## Display text

- Display text keeps Markdown and Slack tokens such as `<@U123>`,
  `<url|label>`, and `:smile:`. The API returns `mentions` beside the owning
  object. Do not resolve names in the dashboard or rewrite tokens on the
  server.
- Render display text only with `client/display-text/DisplayText` (`inline`
  for previews, headings, and buttons). Use `displayPlainText` where markup
  cannot go. Do not add a Markdown, mention, link, or emoji helper.
- `oxlint/display-text.ts` and `no-restricted-imports` enforce this. Do not
  name a local field `text`, `body`, or `summary` when it is not display text.

## Browser assets

- Load Shiki grammars and the theme on demand from `client/code-languages.ts`.
  Do not import the full Shiki bundle.
- Cache content-hashed chunks privately. Keep the entry uncached.
- If highlighting cannot load, show plain text without a reload.

## Tests

- One Playwright spec per user-facing page in `e2e/`. Import `test` from
  `./test` and call `screenshot(page, name)` after load.
- Browser tests cover navigation, interaction, accessibility state, request
  contracts, and failure recovery. Use visual QA for layout and style. Do not
  assert pixel geometry, computed style, or fixed delays.
- Mocks and browser tests use one fixed time, `NOW`.

UI rules: `src/client/components/AGENTS.md` and
`policies/frontend-components.md`.
