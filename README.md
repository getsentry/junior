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

Use evals for end-to-end behavior testing of Junior's reply pipeline (prompting, tools, and expected outputs) with LLM-judged numeric scoring.

Evals intentionally exclude live Slack integration concerns (Slack transport, app permissions, and webhook delivery).

```bash
pnpm evals
```

Add a new eval case to `evals/slack-behaviors.eval.ts`:

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
