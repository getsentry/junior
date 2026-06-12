---
editUrl: false
next: false
prev: false
title: "ConversationSummaryReport"
---

Defined in: [junior/src/reporting/conversations.ts:96](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L96)

## Extended by

- [`ConversationRunReport`](/reference/api/interfaces/conversationrunreport/)

## Properties

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:110](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L110)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:111](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L111)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:107](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L107)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:101](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L101)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:99](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L99)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:100](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L100)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:98](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L98)

Always-populated display title, with privacy redaction applied first.

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:102](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L102)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:106](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L106)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:105](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L105)

---

### requesterIdentity?

> `optional` **requesterIdentity?**: [`RequesterIdentity`](/reference/api/interfaces/requesteridentity/)

Defined in: [junior/src/reporting/conversations.ts:109](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L109)

---

### sentryConversationUrl?

> `optional` **sentryConversationUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:112](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L112)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:113](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L113)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:104](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L104)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:103](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L103)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:108](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L108)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:114](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L114)
