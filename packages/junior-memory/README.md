# @sentry/junior-memory

This package keeps old Junior app configuration valid while Memory moves into `@sentry/junior`.

New apps do not need this package. Memory is part of `@sentry/junior` and is enabled by default. Configure it with `createApp({ memory: { ... } })`.

`memoryPlugin()` is deprecated. It returns a compatibility marker. Current `@sentry/junior` versions accept this marker and use its `modelId`, `disableRecall`, and `disableExtraction` settings. The package re-exports the supported API from `@sentry/junior/memory`.
