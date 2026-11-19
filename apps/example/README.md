# Junior Example App

The reference Junior host app in this repo. Use it to demo and test runtime
behavior from end to end. It has a local skill, a plugin-bundled skill, a
bundle-only plugin, and the installed plugin packages in `plugins.ts`.

## Run

```bash
pnpm install
pnpm dev
```

- `pnpm dev` loads `apps/example/.env.example` as defaults. `.env` and
  `.env.local` files in the repo root or `apps/example/` override them.
- `pnpm dev` starts the `compose.yaml` services and runs `junior upgrade`
  before the app starts.
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
