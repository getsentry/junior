---
editUrl: false
next: false
prev: false
title: "ConversationSummaryReport"
---

Defined in: [junior/src/reporting/conversations.ts:66](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L66)

## Extended by

- [`ConversationRunReport`](/reference/api/interfaces/conversationrunreport/)

## Properties

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:80](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L80)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:81](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L81)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:77](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L77)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:71](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L71)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:69](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L69)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:70](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L70)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:68](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L68)

Always-populated display title, with privacy redaction applied first.

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:72](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L72)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:76](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L76)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:75](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L75)

---

### requesterIdentity?

> `optional` **requesterIdentity?**: [`RequesterIdentity`](/reference/api/interfaces/requesteridentity/)

Defined in: [junior/src/reporting/conversations.ts:79](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L79)

---

### sentryConversationUrl?

> `optional` **sentryConversationUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:82](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L82)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:83](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L83)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:74](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L74)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:73](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L73)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:78](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L78)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:84](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L84)
