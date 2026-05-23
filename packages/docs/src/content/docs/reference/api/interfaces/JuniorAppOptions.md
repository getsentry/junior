---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [app.ts:25](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L25)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [app.ts:27](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L27)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

---

### plugins?

> `optional` **plugins?**: `PluginConfig`

Defined in: [app.ts:29](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L29)

Plugin packages and manifest overrides loaded by this app instance.

---

### waitUntil?

> `optional` **waitUntil?**: `WaitUntilFn`

Defined in: [app.ts:30](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L30)
