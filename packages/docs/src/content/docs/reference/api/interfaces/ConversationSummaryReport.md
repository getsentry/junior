---
editUrl: false
next: false
prev: false
title: "ConversationSummaryReport"
---

Defined in: [junior/src/reporting/conversations.ts:104](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L104)

## Extended by

- [`ConversationRunReport`](/reference/api/interfaces/conversationrunreport/)

## Properties

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:118](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L118)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:119](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L119)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:115](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L115)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:109](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L109)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:107](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L107)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:108](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L108)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:106](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L106)

Always-populated display title, with privacy redaction applied first.

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:110](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L110)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:114](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L114)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:113](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L113)

---

### requesterIdentity?

> `optional` **requesterIdentity?**: [`RequesterIdentity`](/reference/api/interfaces/requesteridentity/)

Defined in: [junior/src/reporting/conversations.ts:117](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L117)

---

### sentryConversationUrl?

> `optional` **sentryConversationUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:120](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L120)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:121](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L121)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:112](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L112)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:111](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L111)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:116](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L116)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:122](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L122)
