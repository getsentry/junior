---
editUrl: false
next: false
prev: false
title: "JuniorNitroOptions"
---

Defined in: [nitro.ts:33](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L33)

## Properties

### cwd?

> `optional` **cwd?**: `string`

Defined in: [nitro.ts:34](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L34)

***

### includeFiles?

> `optional` **includeFiles?**: `string`[]

Defined in: [nitro.ts:44](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L44)

Extra file patterns to copy into the server output for files that the
bundler cannot trace (e.g. dynamically imported providers).
Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`

***

### maxDuration?

> `optional` **maxDuration?**: `number`

Defined in: [nitro.ts:35](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L35)

***

### plugins?

> `optional` **plugins?**: `JuniorNitroPluginSource`

Defined in: [nitro.ts:37](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L37)

Plugin catalog set or runtime-safe plugin module. Direct sets must not include trusted hooks.
