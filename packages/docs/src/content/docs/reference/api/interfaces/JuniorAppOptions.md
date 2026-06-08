---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [junior/src/app.ts:54](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L54)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [junior/src/app.ts:63](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L63)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

---

### conversationWork?

> `optional` **conversationWork?**: `VercelConversationWorkCallbackOptions`

Defined in: [junior/src/app.ts:65](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L65)

Queue consumer wiring for the durable conversation worker.

---

### plugins?

> `optional` **plugins?**: [`JuniorPluginSet`](/reference/api/interfaces/juniorpluginset/)

Defined in: [junior/src/app.ts:67](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L67)

Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module.

---

### slack?

> `optional` **slack?**: `object`

Defined in: [junior/src/app.ts:56](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L56)

Slack-specific overrides applied after env parsing.

#### completedReactionEmoji?

> `optional` **completedReactionEmoji?**: `string`

Slack emoji shown after a turn completes. Defaults to `white_check_mark`.

#### processingReactionEmoji?

> `optional` **processingReactionEmoji?**: `string`

Slack emoji shown while Junior is processing. Defaults to `eyes`.

---

### waitUntil?

> `optional` **waitUntil?**: `WaitUntilFn`

Defined in: [junior/src/app.ts:68](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L68)
