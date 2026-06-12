---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [junior/src/app.ts:61](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L61)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [junior/src/app.ts:70](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L70)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

---

### conversationWork?

> `optional` **conversationWork?**: `VercelConversationWorkCallbackOptions`

Defined in: [junior/src/app.ts:72](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L72)

Queue consumer wiring for the durable conversation worker.

---

### plugins?

> `optional` **plugins?**: [`JuniorPluginSet`](/reference/api/interfaces/juniorpluginset/)

Defined in: [junior/src/app.ts:74](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L74)

Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module.

---

### sandbox?

> `optional` **sandbox?**: `object`

Defined in: [junior/src/app.ts:76](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L76)

Sandbox execution options.

#### egressTracePropagationDomains?

> `optional` **egressTracePropagationDomains?**: `string`[]

Egress domains allowed to carry Sentry trace propagation headers.
Entries may be exact domains or leading wildcard domains such as
`*.sentry.io`; wildcard entries match subdomains, not the apex domain.

---

### slack?

> `optional` **slack?**: `object`

Defined in: [junior/src/app.ts:63](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L63)

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

Defined in: [junior/src/app.ts:84](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L84)
