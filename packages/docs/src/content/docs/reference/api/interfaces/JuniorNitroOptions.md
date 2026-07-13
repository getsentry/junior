---
editUrl: false
next: false
prev: false
title: "JuniorNitroOptions"
---

Defined in: [junior/src/nitro.ts:45](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L45)

## Properties

### conversationWorkQueueTopic?

> `optional` **conversationWorkQueueTopic?**: `string`

Defined in: [junior/src/nitro.ts:51](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L51)

Vercel Queue topic for durable conversation work. Must match the runtime queue producer topic.

---

### cwd?

> `optional` **cwd?**: `string`

Defined in: [junior/src/nitro.ts:46](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L46)

---

### dashboard?

> `optional` **dashboard?**: [`JuniorDashboardOptions`](/reference/api/interfaces/juniordashboardoptions/)

Defined in: [junior/src/nitro.ts:48](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L48)

Authenticated dashboard configuration injected for createApp().

---

### includeFiles?

> `optional` **includeFiles?**: `string`[]

Defined in: [junior/src/nitro.ts:60](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L60)

Extra file patterns to copy into the server output for files that the
bundler cannot trace (e.g. dynamically imported providers).
Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`

---

### maxDuration?

> `optional` **maxDuration?**: `number`

Defined in: [junior/src/nitro.ts:49](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L49)

---

### plugins?

> `optional` **plugins?**: `JuniorNitroPluginSource`

Defined in: [junior/src/nitro.ts:53](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L53)

Plugin catalog set or runtime-safe plugin module. Direct sets must not include runtime code.
