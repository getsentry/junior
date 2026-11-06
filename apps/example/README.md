# Junior Example App

The reference Junior host app in this repo. Use it to demo and test runtime
behavior from end to end. It has a local skill, a plugin-bundled skill, a
bundle-only plugin, and the installed plugin packages in `plugins.ts`.

## Run

```bash
pnpm install
cp apps/example/.env.example apps/example/.env
docker compose up -d --wait
pnpm cli -- upgrade
pnpm dev
```

- `DATABASE_URL` points at the repo Docker Postgres. Run `pnpm cli -- upgrade`
  after the services start, so Junior and plugins have their SQL schemas.
- Attachments and published images use the compose `s3` service. Without it,
  `sendFiles`, `publishImage`, and web messages with images fail. To use the
  dev Vercel Blob store, set `JUNIOR_ATTACHMENT_STORAGE_PROVIDER=vercel-blob`.
  Files stored with one provider are not visible from the other.
- Root `pnpm dev` calls `/api/internal/heartbeat` every minute, as the
  production cron does.

## Wiring

- `plugins.ts` is the one list of plugin registrations.
- `nitro.config.ts` and `server.ts` both use that list, so dev and built
  bundles load the same plugins.
