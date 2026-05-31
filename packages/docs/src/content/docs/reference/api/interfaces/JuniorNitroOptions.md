---
editUrl: false
next: false
prev: false
title: "JuniorNitroOptions"
---

Defined in: [nitro.ts:15](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L15)

## Properties

### cwd?

> `optional` **cwd?**: `string`

Defined in: [nitro.ts:16](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L16)

***

### includeFiles?

> `optional` **includeFiles?**: `string`[]

Defined in: [nitro.ts:26](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L26)

Extra file patterns to copy into the server output for files that the
bundler cannot trace (e.g. dynamically imported providers).
Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`

***

### maxDuration?

> `optional` **maxDuration?**: `number`

Defined in: [nitro.ts:17](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L17)

***

### plugins?

> `optional` **plugins?**: [`JuniorPluginSet`](/reference/api/interfaces/juniorpluginset/)

Defined in: [nitro.ts:19](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L19)

Plugin package names and JS definitions bundled into the app. Pass the same set to `createApp()`.
