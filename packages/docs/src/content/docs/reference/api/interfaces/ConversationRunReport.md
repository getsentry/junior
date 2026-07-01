---
editUrl: false
next: false
prev: false
title: "ConversationRunReport"
---

Defined in: [junior/src/reporting/conversations.ts:166](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L166)

## Extends

- [`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/)

## Properties

### activity?

> `optional` **activity?**: [`ConversationActivityReport`](/reference/api/type-aliases/conversationactivityreport/)[]

Defined in: [junior/src/reporting/conversations.ts:167](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L167)

---

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:118](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L118)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channel`](/reference/api/interfaces/conversationsummaryreport/#channel)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:119](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L119)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channelName`](/reference/api/interfaces/conversationsummaryreport/#channelname)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:115](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L115)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`completedAt`](/reference/api/interfaces/conversationsummaryreport/#completedat)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:109](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L109)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`conversationId`](/reference/api/interfaces/conversationsummaryreport/#conversationid)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:107](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L107)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeDurationMs`](/reference/api/interfaces/conversationsummaryreport/#cumulativedurationms)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:108](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L108)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeUsage`](/reference/api/interfaces/conversationsummaryreport/#cumulativeusage)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:106](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L106)

Always-populated display title, with privacy redaction applied first.

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`displayTitle`](/reference/api/interfaces/conversationsummaryreport/#displaytitle)

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:110](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L110)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`id`](/reference/api/interfaces/conversationsummaryreport/#id)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:114](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L114)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastProgressAt`](/reference/api/interfaces/conversationsummaryreport/#lastprogressat)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:113](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L113)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastSeenAt`](/reference/api/interfaces/conversationsummaryreport/#lastseenat)

---

### requesterIdentity?

> `optional` **requesterIdentity?**: [`RequesterIdentity`](/reference/api/interfaces/requesteridentity/)

Defined in: [junior/src/reporting/conversations.ts:117](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L117)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`requesterIdentity`](/reference/api/interfaces/conversationsummaryreport/#requesteridentity)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:120](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L120)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`sentryTraceUrl`](/reference/api/interfaces/conversationsummaryreport/#sentrytraceurl)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:112](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L112)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`startedAt`](/reference/api/interfaces/conversationsummaryreport/#startedat)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:111](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L111)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`status`](/reference/api/interfaces/conversationsummaryreport/#status)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:116](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L116)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`surface`](/reference/api/interfaces/conversationsummaryreport/#surface)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:121](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L121)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`traceId`](/reference/api/interfaces/conversationsummaryreport/#traceid)

---

### transcript

> **transcript**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: [junior/src/reporting/conversations.ts:173](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L173)

---

### transcriptAvailable

> **transcriptAvailable**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:168](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L168)

---

### transcriptMessageCount?

> `optional` **transcriptMessageCount?**: `number`

Defined in: [junior/src/reporting/conversations.ts:170](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L170)

---

### transcriptMetadata?

> `optional` **transcriptMetadata?**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: [junior/src/reporting/conversations.ts:169](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L169)

---

### transcriptRedacted?

> `optional` **transcriptRedacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:171](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L171)

---

### transcriptRedactionReason?

> `optional` **transcriptRedactionReason?**: `"non_public_conversation"`

Defined in: [junior/src/reporting/conversations.ts:172](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L172)
