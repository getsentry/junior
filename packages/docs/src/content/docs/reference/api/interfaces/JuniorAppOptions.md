---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [app.ts:57](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L57)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [app.ts:59](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L59)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

---

### conversationWork?

> `optional` **conversationWork?**: `VercelConversationWorkCallbackOptions`

Defined in: [app.ts:61](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L61)

Queue consumer wiring for the durable conversation worker.

---

### plugins?

> `optional` **plugins?**: [`JuniorPluginSet`](/reference/api/interfaces/juniorpluginset/)

Defined in: [app.ts:63](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L63)

Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module.

---

### waitUntil?

> `optional` **waitUntil?**: `WaitUntilFn`

Defined in: [app.ts:64](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L64)
