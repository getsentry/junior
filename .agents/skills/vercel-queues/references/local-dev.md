# Local Development Reference

Primary sources:
- https://vercel.com/docs/queues/quickstart
- https://vercel.com/docs/queues/sdk

## Setup checklist

1. Install Vercel CLI: `npm i -g vercel`
2. Link project: `vc link`
3. Pull env: `vc env pull`
4. Install SDK: `pnpm i @vercel/queue`
5. Confirm queue trigger in `vercel.json`

## Expected local behavior

- In development, the SDK supports local iteration where sent messages are processed through configured callback code paths.
- `send` can be exercised from local server routes, server actions, or other server-side code.

## Debug checklist

1. Auth: verify env pull succeeded and credentials are current.
2. Trigger mapping: verify route path in `vercel.json` exactly matches consumer handler file.
3. Topic consistency: verify producer topic and trigger topic strings match exactly.
4. Region (poll mode): verify sender and poller use same region.
5. Retry storms: add bounded retry with poison-message acknowledge logic.
