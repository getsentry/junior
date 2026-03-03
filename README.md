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

3. Start the app.

```bash
pnpm dev
```

## Slack tunnel (Cloudflare)

Install `cloudflared` if you don't have it (`brew install cloudflared` on macOS).

### Quick (random hostname each time)

```bash
cloudflared tunnel --url http://localhost:3000
```

### Stable hostname (one-time setup)

Requires a free Cloudflare account and a domain managed through Cloudflare DNS.

```bash
cloudflared tunnel login
cloudflared tunnel create junior-dev
cloudflared tunnel route dns junior-dev junior-dev.yourdomain.com
```

Then each time you develop:

```bash
cloudflared tunnel run --url http://localhost:3000 junior-dev
```

### Configuring Slack

Set Slack Event Subscriptions and Interactivity request URL to:

```text
https://<tunnel-host>/api/webhooks/slack
```

With a stable hostname you only need to do this once. Invite `@junior` to a channel and mention it.

## Evals

Use evals for end-to-end behavior testing of Junior's reply pipeline (prompting, tools, and expected outputs) with LLM-judged numeric scoring.

Evals intentionally exclude live Slack integration concerns (Slack transport, app permissions, and webhook delivery).

```bash
pnpm evals
```

Add a new conversational eval case under `evals/conversational/*.eval.ts`:

```typescript
slackEval("my new case", {
  events: [mention("<@U_APP> do the thing")],
  assert: (result) => {
    expect(result.posts).toHaveLength(1);
  },
  criteria: "Posts exactly one reply to the mention.",
});
```

Then run:

```bash
pnpm evals
```
