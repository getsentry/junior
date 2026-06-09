---
editUrl: false
next: false
prev: false
title: "JuniorNitroOptions"
---

Defined in: [junior/src/nitro.ts:39](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L39)

## Properties

### conversationWorkQueueTopic?

> `optional` **conversationWorkQueueTopic?**: `string`

Defined in: [junior/src/nitro.ts:43](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L43)

Vercel Queue topic for durable conversation work. Must match the runtime queue producer topic.

---

### cwd?

> `optional` **cwd?**: `string`

Defined in: [junior/src/nitro.ts:40](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L40)

---

### includeFiles?

> `optional` **includeFiles?**: `string`[]

Defined in: [junior/src/nitro.ts:52](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L52)

Extra file patterns to copy into the server output for files that the
bundler cannot trace (e.g. dynamically imported providers).
Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`

---

### maxDuration?

> `optional` **maxDuration?**: `number`

Defined in: [junior/src/nitro.ts:41](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L41)

---

### plugins?

> `optional` **plugins?**: `JuniorNitroPluginSource`

Defined in: [junior/src/nitro.ts:45](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L45)

Plugin catalog set or runtime-safe plugin module. Direct sets must not include runtime hooks.
