---
editUrl: false
next: false
prev: false
title: "ConversationSummaryReport"
---

Defined in: [junior/src/reporting/conversations.ts:74](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L74)

## Extended by

- [`ConversationRunReport`](/reference/api/interfaces/conversationrunreport/)

## Properties

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:88](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L88)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:89](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L89)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:85](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L85)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:79](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L79)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:77](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L77)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:78](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L78)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:76](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L76)

Always-populated display title, with privacy redaction applied first.

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:80](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L80)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:84](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L84)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:83](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L83)

---

### requesterIdentity?

> `optional` **requesterIdentity?**: [`RequesterIdentity`](/reference/api/interfaces/requesteridentity/)

Defined in: [junior/src/reporting/conversations.ts:87](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L87)

---

### sentryConversationUrl?

> `optional` **sentryConversationUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:90](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L90)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:91](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L91)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:82](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L82)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:81](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L81)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:86](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L86)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:92](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L92)
