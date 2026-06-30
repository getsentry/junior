---
title: API Reference Guide
description: How to use the generated API reference effectively.
type: reference
summary: Find the generated API entrypoints for app creation, Nitro wiring, Vercel config, handlers, and instrumentation.
prerequisites:
  - /reference/handler-surface/
related:
  - /operate/dashboard/
  - /reference/config-and-env/
  - /start-here/quickstart/
---

The API reference is generated from public package entry points.

## Start points

- [Package API index](/reference/api/readme/)
- [App factory](/reference/api/functions/createapp/)
- [Nitro wiring](/reference/api/functions/juniornitro/)
- [Vercel config helper](/reference/api/functions/juniorvercelconfig/)
- [Instrumentation](/reference/api/functions/initsentry/)
- [Reporting](/reference/api/functions/createjuniorreporting/)

## Suggested reading order

1. Read [Route & Handler Surface](/reference/handler-surface/) first.
2. Read `createApp` options to understand runtime route wiring.
3. Read `juniorNitro` options before changing plugin package bundling.
4. For plugin hooks, use `@sentry/junior-plugin-api` from a plugin
   package and register the returned `JuniorPlugin` with `createApp()`.
5. Read reporting exports when building dashboard or operational views.
6. Read instrumentation exports for telemetry setup.

## Next step

Apply the exported surfaces in [Quickstart](/start-here/quickstart/), then validate runtime routes with [Route & Handler Surface](/reference/handler-surface/).
