---
editUrl: false
next: false
prev: false
title: "ConversationRunReport"
---

Defined in: [junior/src/reporting/conversations.ts:159](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L159)

## Extends

- [`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/)

## Properties

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:110](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L110)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channel`](/reference/api/interfaces/conversationsummaryreport/#channel)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:111](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L111)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channelName`](/reference/api/interfaces/conversationsummaryreport/#channelname)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:107](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L107)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`completedAt`](/reference/api/interfaces/conversationsummaryreport/#completedat)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:101](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L101)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`conversationId`](/reference/api/interfaces/conversationsummaryreport/#conversationid)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:99](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L99)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeDurationMs`](/reference/api/interfaces/conversationsummaryreport/#cumulativedurationms)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:100](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L100)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeUsage`](/reference/api/interfaces/conversationsummaryreport/#cumulativeusage)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:98](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L98)

Always-populated display title, with privacy redaction applied first.

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`displayTitle`](/reference/api/interfaces/conversationsummaryreport/#displaytitle)

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:102](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L102)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`id`](/reference/api/interfaces/conversationsummaryreport/#id)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:106](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L106)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastProgressAt`](/reference/api/interfaces/conversationsummaryreport/#lastprogressat)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:105](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L105)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastSeenAt`](/reference/api/interfaces/conversationsummaryreport/#lastseenat)

---

### requesterIdentity?

> `optional` **requesterIdentity?**: [`RequesterIdentity`](/reference/api/interfaces/requesteridentity/)

Defined in: [junior/src/reporting/conversations.ts:109](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L109)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`requesterIdentity`](/reference/api/interfaces/conversationsummaryreport/#requesteridentity)

---

### sentryConversationUrl?

> `optional` **sentryConversationUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:112](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L112)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`sentryConversationUrl`](/reference/api/interfaces/conversationsummaryreport/#sentryconversationurl)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:113](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L113)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`sentryTraceUrl`](/reference/api/interfaces/conversationsummaryreport/#sentrytraceurl)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:104](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L104)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`startedAt`](/reference/api/interfaces/conversationsummaryreport/#startedat)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:103](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L103)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`status`](/reference/api/interfaces/conversationsummaryreport/#status)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:108](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L108)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`surface`](/reference/api/interfaces/conversationsummaryreport/#surface)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:114](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L114)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`traceId`](/reference/api/interfaces/conversationsummaryreport/#traceid)

---

### transcript

> **transcript**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: [junior/src/reporting/conversations.ts:165](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L165)

---

### transcriptAvailable

> **transcriptAvailable**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:160](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L160)

---

### transcriptMessageCount?

> `optional` **transcriptMessageCount?**: `number`

Defined in: [junior/src/reporting/conversations.ts:162](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L162)

---

### transcriptMetadata?

> `optional` **transcriptMetadata?**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: [junior/src/reporting/conversations.ts:161](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L161)

---

### transcriptRedacted?

> `optional` **transcriptRedacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:163](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L163)

---

### transcriptRedactionReason?

> `optional` **transcriptRedactionReason?**: `"non_public_conversation"`

Defined in: [junior/src/reporting/conversations.ts:164](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L164)
