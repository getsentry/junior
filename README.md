# shim

Slack bot built with Chat SDK + Next.js + a skill-aware harness.

The bot behavior is:
- On `@shim` mention: subscribe to that thread and respond.
- After subscription: respond to follow-up messages in that same thread.

## Core design

- Runtime: `chat` + `@chat-adapter/slack`
- Webhook endpoint: `POST /api/webhooks/slack`
- Health endpoint: `GET /api/health`
- Model execution: AI SDK (`ai`) using AI Gateway model IDs
- State: Redis in prod (`REDIS_URL`), memory fallback in dev
- Tools: `load_skill`, `web_search`, `web_fetch`
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
- [`slack-manifest.yml`](/home/dcramer/src/shim/slack-manifest.yml)

```yaml
display_information:
  name: shim
features:
  bot_user:
    display_name: shim
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
settings:
  event_subscriptions:
    request_url: https://example.com/api/webhooks/slack
    bot_events:
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
- Invite bot: `/invite @shim`
- Mention bot in a thread: `@shim hello`
- Verify it responds and continues responding to replies in that thread.

## Deploy on Vercel

1. Deploy app.
2. Set env vars in Vercel:
- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET`
- `AI_MODEL` (optional)
- `REDIS_URL` (recommended)
- `SKILL_DIRS` (optional)
3. Update Slack request/interactivity URLs to:
- `https://<vercel-domain>/api/webhooks/slack`

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
