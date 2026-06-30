---
editUrl: false
next: false
prev: false
title: "JuniorNitroOptions"
---

Defined in: [junior/src/nitro.ts:46](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L46)

## Properties

### conversationWorkQueueTopic?

> `optional` **conversationWorkQueueTopic?**: `string`

Defined in: [junior/src/nitro.ts:52](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L52)

Vercel Queue topic for durable conversation work. Must match the runtime queue producer topic.

---

### cwd?

> `optional` **cwd?**: `string`

Defined in: [junior/src/nitro.ts:47](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L47)

---

### dashboard?

> `optional` **dashboard?**: [`JuniorNitroDashboardOptions`](/reference/api/type-aliases/juniornitrodashboardoptions/)

Defined in: [junior/src/nitro.ts:49](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L49)

Authenticated dashboard configuration injected for createApp().

---

### includeFiles?

> `optional` **includeFiles?**: `string`[]

Defined in: [junior/src/nitro.ts:61](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L61)

Extra file patterns to copy into the server output for files that the
bundler cannot trace (e.g. dynamically imported providers).
Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`

---

### maxDuration?

> `optional` **maxDuration?**: `number`

Defined in: [junior/src/nitro.ts:50](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L50)

---

### plugins?

> `optional` **plugins?**: `JuniorNitroPluginSource`

Defined in: [junior/src/nitro.ts:54](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L54)

Plugin catalog set or runtime-safe plugin module. Direct sets must not include runtime code.
