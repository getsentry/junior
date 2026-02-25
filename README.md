# junior

Slack bot built with Next.js + Chat SDK.

Junior responds when mentioned in Slack and can continue replying in subscribed threads. It also supports slash-invoked local skills (`/skill-name ...`) and built-in tools (web search/fetch, image generation, Slack canvases/lists).

## Requirements

- Node.js 20+
- pnpm
- Vercel CLI
- Slack app credentials already configured in Vercel
- Redis configured in Vercel (`REDIS_URL`)

## Local setup

1. Install dependencies.

```bash
pnpm install
```

2. Link this repo to the Sentry Vercel project and pull dev env.

```bash
pnpm dlx vercel@latest login
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes --scope sentry
pnpm dlx vercel@latest env pull .env --environment=development --scope sentry
```

If you linked to your personal org by mistake:

```bash
rm -rf .vercel
pnpm dlx vercel@latest switch
pnpm dlx vercel@latest link --yes --scope sentry
```

3. Start the app.

```bash
pnpm dev
```

## Ngrok for Slack

1. Expose local port `3000`.

```bash
ngrok http 3000
```

2. Set Slack Event Subscriptions and Interactivity request URL to:

```text
https://<ngrok-host>/api/webhooks/slack
```

3. Invite `@junior` to a channel and mention it.

## Evals

LLM-judged numeric scoring:

```bash
pnpm evals
```

Add a new eval by appending one case to [`evals/cases/slack-behaviors.yaml`](/home/dcramer/src/junior/evals/cases/slack-behaviors.yaml):

```yaml
- id: my_new_case
  description: Short description of expected behavior.
  events:
    - type: new_mention
      thread:
        id: thread-my-case
      message:
        text: "<@U_APP> do the thing"
        is_mention: true
  expected:
    posts_count: 1
    posts_contain:
      - "summary"
```

Then run:

```bash
pnpm evals
```

## Notes

- `REDIS_URL` is required; there is no in-memory fallback for state.
- If Sentry env vars are set, server/client instrumentation is enabled automatically.
