---
editUrl: false
next: false
prev: false
title: "ConversationRunReport"
---

Defined in: [junior/src/reporting/conversations.ts:129](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L129)

## Extends

- [`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/)

## Properties

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:80](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L80)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channel`](/reference/api/interfaces/conversationsummaryreport/#channel)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:81](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L81)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channelName`](/reference/api/interfaces/conversationsummaryreport/#channelname)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:77](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L77)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`completedAt`](/reference/api/interfaces/conversationsummaryreport/#completedat)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:71](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L71)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`conversationId`](/reference/api/interfaces/conversationsummaryreport/#conversationid)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:69](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L69)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeDurationMs`](/reference/api/interfaces/conversationsummaryreport/#cumulativedurationms)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:70](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L70)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeUsage`](/reference/api/interfaces/conversationsummaryreport/#cumulativeusage)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:68](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L68)

Always-populated display title, with privacy redaction applied first.

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`displayTitle`](/reference/api/interfaces/conversationsummaryreport/#displaytitle)

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:72](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L72)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`id`](/reference/api/interfaces/conversationsummaryreport/#id)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:76](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L76)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastProgressAt`](/reference/api/interfaces/conversationsummaryreport/#lastprogressat)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:75](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L75)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastSeenAt`](/reference/api/interfaces/conversationsummaryreport/#lastseenat)

---

### requesterIdentity?

> `optional` **requesterIdentity?**: [`RequesterIdentity`](/reference/api/interfaces/requesteridentity/)

Defined in: [junior/src/reporting/conversations.ts:79](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L79)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`requesterIdentity`](/reference/api/interfaces/conversationsummaryreport/#requesteridentity)

---

### sentryConversationUrl?

> `optional` **sentryConversationUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:82](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L82)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`sentryConversationUrl`](/reference/api/interfaces/conversationsummaryreport/#sentryconversationurl)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:83](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L83)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`sentryTraceUrl`](/reference/api/interfaces/conversationsummaryreport/#sentrytraceurl)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:74](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L74)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`startedAt`](/reference/api/interfaces/conversationsummaryreport/#startedat)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:73](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L73)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`status`](/reference/api/interfaces/conversationsummaryreport/#status)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:78](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L78)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`surface`](/reference/api/interfaces/conversationsummaryreport/#surface)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:84](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L84)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`traceId`](/reference/api/interfaces/conversationsummaryreport/#traceid)

---

### transcript

> **transcript**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: [junior/src/reporting/conversations.ts:135](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L135)

---

### transcriptAvailable

> **transcriptAvailable**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:130](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L130)

---

### transcriptMessageCount?

> `optional` **transcriptMessageCount?**: `number`

Defined in: [junior/src/reporting/conversations.ts:132](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L132)

---

### transcriptMetadata?

> `optional` **transcriptMetadata?**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: [junior/src/reporting/conversations.ts:131](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L131)

---

### transcriptRedacted?

> `optional` **transcriptRedacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:133](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L133)

---

### transcriptRedactionReason?

> `optional` **transcriptRedactionReason?**: `"non_public_conversation"`

Defined in: [junior/src/reporting/conversations.ts:134](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L134)
