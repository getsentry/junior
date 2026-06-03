---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [app.ts:53](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L53)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [app.ts:55](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L55)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

---

### conversationWork?

> `optional` **conversationWork?**: `VercelConversationWorkCallbackOptions`

Defined in: [app.ts:57](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L57)

Queue consumer wiring for the durable conversation worker.

---

### plugins?

> `optional` **plugins?**: [`JuniorPluginSet`](/reference/api/interfaces/juniorpluginset/)

Defined in: [app.ts:59](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L59)

Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module.

---

### waitUntil?

> `optional` **waitUntil?**: `WaitUntilFn`

Defined in: [app.ts:60](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L60)
