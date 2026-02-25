# junior

Slack bot built with Chat SDK + Next.js + a skill-aware harness.

The bot behavior is:
- On `@junior` mention: subscribe to that thread and respond.
- After subscription: respond to follow-up messages in that same thread.

## Core design

- Runtime: `chat` + `@chat-adapter/slack`
- Webhook endpoint: `POST /api/webhooks/slack`
- Health endpoint: `GET /api/health`
- Model execution: AI SDK (`ai`) using AI Gateway model IDs
- State: Redis in prod (`REDIS_URL`), memory fallback in dev
- Tools: `load_skill`, `web_search`, `web_fetch`
- `web_search` uses AI Gateway `parallelSearch` (agentic mode)
- `web_fetch` converts HTML to markdown-like content (headings/lists/links) for better agent grounding
- Skills: loaded from `skills/*/SKILL.md` with YAML validation

## Local setup

1. Install deps:

```bash
npm install
```

2. Create local env:

```bash
cp .env.example .env.local
```

3. Fill `.env.local`:
- `SLACK_BOT_TOKEN` (from Slack app OAuth)
- `SLACK_SIGNING_SECRET` (from Slack app Basic Information)
- `AI_MODEL` (optional; default `anthropic/claude-sonnet-4.6`)
- `REDIS_URL` (optional for local; recommended for prod)
- `SKILL_DIRS` (optional extra skill roots)
- `SENTRY_DSN` (optional locally; required for Sentry event capture)
- `NEXT_PUBLIC_SENTRY_DSN` (for browser-side error capture)
- `SENTRY_TRACES_SAMPLE_RATE` (default `1.0`)
- `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` (default `1.0`)
- `JUNIOR_PROGRESS_FALLBACK_ENABLED` (default `false`)

4. Validate skills:

```bash
npm run skills:check
```

5. Run dev server:

```bash
npm run dev
```

## Create and wire a Slack app

1. Go to https://api.slack.com/apps
2. Create app from manifest (recommended) and use:

Use the checked-in manifest file:
- [`slack-manifest.yml`](slack-manifest.yml)

```yaml
display_information:
  name: junior
features:
  bot_user:
    display_name: junior
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    request_url: https://example.com/api/webhooks/slack
    bot_events:
      - assistant_thread_started
      - assistant_thread_context_changed
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
    request_url: https://example.com/api/webhooks/slack
  socket_mode_enabled: false
```

3. Install app to workspace.
4. Copy bot token and signing secret into `.env.local`.

## Test locally with Slack

1. Start app:

```bash
npm run dev
```

2. Expose local server with a tunnel (example with `ngrok`):

```bash
ngrok http 3000
```

3. Set Slack request URLs to:
- `https://<your-ngrok-domain>/api/webhooks/slack` for Event Subscriptions
- `https://<your-ngrok-domain>/api/webhooks/slack` for Interactivity

4. In Slack channel:
- Invite bot: `/invite @junior`
- Mention bot in a thread: `@junior hello`
- Verify it responds and continues responding to replies in that thread.

## Deploy on Vercel

1. Deploy app.
2. Set env vars in Vercel:
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `AI_MODEL` (optional)
- `REDIS_URL` (recommended)
- `SKILL_DIRS` (optional)
- `SENTRY_DSN`
- `NEXT_PUBLIC_SENTRY_DSN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`
- `SENTRY_AUTH_TOKEN`
- `SENTRY_ENVIRONMENT` (for example `production`)
- `NEXT_PUBLIC_SENTRY_ENVIRONMENT` (for example `production`)
- `SENTRY_RELEASE` (optional; defaults to commit SHA in Vercel)
- `NEXT_PUBLIC_SENTRY_RELEASE` (optional)
3. Update Slack request/interactivity URLs to:
- `https://<vercel-domain>/api/webhooks/slack`

## Sentry setup

This project uses `@sentry/nextjs` with:
- Next.js browser + server runtime initialization
- AI SDK tracing integration (`Sentry.vercelAIIntegration`)
- Error capture in webhook and chat workflow handlers
- Correlation tags for Slack thread/user and workflow run IDs

To finish setup:
1. Create a Sentry project and copy its DSN.
2. Set the Vercel env vars listed above.
3. Deploy once so source maps upload during `next build`.
4. Trigger a test error and confirm stack traces resolve in Sentry.

## Skills

- Skill path: `skills/<skill-name>/SKILL.md`
- Frontmatter must include:
- `name` (matches folder name; strict kebab-case rules)
- `description` (non-empty, <=1024, no `<` or `>`)
- Skill invocation syntax:
- `/<skill-name> [optional arguments]`
- Unknown skill returns an explicit error and available skills list.

## Quality checks

```bash
npm run typecheck
npm run test
npm run skills:check
```
