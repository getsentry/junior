---
editUrl: false
next: false
prev: false
title: "ConversationSummaryReport"
---

Defined in: [junior/src/reporting/conversations.ts:122](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L122)

## Extended by

- [`ConversationRunReport`](/reference/api/interfaces/conversationrunreport/)

## Properties

### actorIdentity?

> `optional` **actorIdentity?**: [`ActorIdentity`](/reference/api/interfaces/actoridentity/)

Defined in: [junior/src/reporting/conversations.ts:135](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L135)

---

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:136](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L136)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:137](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L137)

---

### channelNameRedacted?

> `optional` **channelNameRedacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:138](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L138)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:133](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L133)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:127](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L127)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:125](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L125)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:126](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L126)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:124](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L124)

Always-populated display title, with privacy redaction applied first.

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:128](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L128)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:132](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L132)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:131](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L131)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:139](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L139)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:130](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L130)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:129](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L129)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:134](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L134)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:140](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L140)
