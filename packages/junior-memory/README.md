# @sentry/junior-memory

Memory is a Junior core feature. `@sentry/junior` registers it inside
`createApp()`, owns its schema and migrations, and exposes the supported API
from `@sentry/junior/memory`. Feature docs live in
`../junior/src/chat/memory/README.md`.

This package is a temporary compatibility shim for apps that still import it:

- It re-exports the supported Memory API from `@sentry/junior/memory`.
- `memoryPlugin()` returns a deprecated marker. `@sentry/junior` ignores it
  with one startup warning. Its options no longer take effect; use
  `createApp({ memory: { disableRecall, disableExtraction, modelId } })` instead.
- The `migrations/` directory keeps the legacy plugin migration history for
  audit only. `@sentry/junior` no longer discovers or applies it; the core
  migration reconciles existing Memory tables.

Remove `@sentry/junior-memory` from your app once nothing imports it. The
package will be deleted after the compatibility window.
