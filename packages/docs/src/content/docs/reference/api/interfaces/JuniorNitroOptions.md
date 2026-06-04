---
editUrl: false
next: false
prev: false
title: "JuniorNitroOptions"
---

Defined in: [nitro.ts:37](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L37)

## Properties

### conversationWorkQueueTopic?

> `optional` **conversationWorkQueueTopic?**: `string`

Defined in: [nitro.ts:41](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L41)

Vercel Queue topic for durable conversation work. Must match the runtime queue producer topic.

---

### cwd?

> `optional` **cwd?**: `string`

Defined in: [nitro.ts:38](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L38)

---

### includeFiles?

> `optional` **includeFiles?**: `string`[]

Defined in: [nitro.ts:50](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L50)

Extra file patterns to copy into the server output for files that the
bundler cannot trace (e.g. dynamically imported providers).
Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`

---

### maxDuration?

> `optional` **maxDuration?**: `number`

Defined in: [nitro.ts:39](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L39)

---

### plugins?

> `optional` **plugins?**: `JuniorNitroPluginSource`

Defined in: [nitro.ts:43](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L43)

Plugin catalog set or runtime-safe plugin module. Direct sets must not include trusted hooks.
