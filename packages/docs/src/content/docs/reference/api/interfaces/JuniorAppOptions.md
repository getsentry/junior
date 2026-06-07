---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [app.ts:55](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L55)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [app.ts:64](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L64)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

---

### conversationWork?

> `optional` **conversationWork?**: `VercelConversationWorkCallbackOptions`

Defined in: [app.ts:66](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L66)

Queue consumer wiring for the durable conversation worker.

---

### plugins?

> `optional` **plugins?**: [`JuniorPluginSet`](/reference/api/interfaces/juniorpluginset/)

Defined in: [app.ts:68](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L68)

Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module.

---

### slack?

> `optional` **slack?**: `object`

Defined in: [app.ts:57](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L57)

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

Defined in: [app.ts:69](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L69)
