---
editUrl: false
next: false
prev: false
title: "JuniorNitroOptions"
---

Defined in: [nitro.ts:11](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L11)

## Properties

### cwd?

> `optional` **cwd?**: `string`

Defined in: [nitro.ts:12](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L12)

---

### includeFiles?

> `optional` **includeFiles?**: `string`[]

Defined in: [nitro.ts:22](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L22)

Extra file patterns to copy into the server output for files that the
bundler cannot trace (e.g. dynamically imported providers).
Each entry is `"<package-name>/<subpath-glob>"`, resolved via Node
module resolution. Example: `"@earendil-works/pi-ai/dist/providers/*.js"`

---

### maxDuration?

> `optional` **maxDuration?**: `number`

Defined in: [nitro.ts:13](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L13)

---

### plugins?

> `optional` **plugins?**: `PluginConfig`

Defined in: [nitro.ts:15](https://github.com/getsentry/junior/blob/main/packages/junior/src/nitro.ts#L15)

Plugin packages and manifest overrides bundled into the app.
