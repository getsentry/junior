---
editUrl: false
next: false
prev: false
title: "ConversationRunReport"
---

Defined in: [junior/src/reporting/conversations.ts:185](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L185)

## Extends

- [`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/)

## Properties

### activity?

> `optional` **activity?**: [`ConversationActivityReport`](/reference/api/type-aliases/conversationactivityreport/)[]

Defined in: [junior/src/reporting/conversations.ts:186](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L186)

---

### actorIdentity?

> `optional` **actorIdentity?**: [`ActorIdentity`](/reference/api/interfaces/actoridentity/)

Defined in: [junior/src/reporting/conversations.ts:135](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L135)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`actorIdentity`](/reference/api/interfaces/conversationsummaryreport/#actoridentity)

---

### channel?

> `optional` **channel?**: `string`

Defined in: [junior/src/reporting/conversations.ts:136](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L136)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channel`](/reference/api/interfaces/conversationsummaryreport/#channel)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: [junior/src/reporting/conversations.ts:137](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L137)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channelName`](/reference/api/interfaces/conversationsummaryreport/#channelname)

---

### channelNameRedacted?

> `optional` **channelNameRedacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:138](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L138)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channelNameRedacted`](/reference/api/interfaces/conversationsummaryreport/#channelnameredacted)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: [junior/src/reporting/conversations.ts:133](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L133)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`completedAt`](/reference/api/interfaces/conversationsummaryreport/#completedat)

---

### conversationId

> **conversationId**: `string`

Defined in: [junior/src/reporting/conversations.ts:127](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L127)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`conversationId`](/reference/api/interfaces/conversationsummaryreport/#conversationid)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: [junior/src/reporting/conversations.ts:125](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L125)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeDurationMs`](/reference/api/interfaces/conversationsummaryreport/#cumulativedurationms)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: [junior/src/reporting/conversations.ts:126](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L126)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeUsage`](/reference/api/interfaces/conversationsummaryreport/#cumulativeusage)

---

### displayTitle

> **displayTitle**: `string`

Defined in: [junior/src/reporting/conversations.ts:124](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L124)

Always-populated display title, with privacy redaction applied first.

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`displayTitle`](/reference/api/interfaces/conversationsummaryreport/#displaytitle)

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:128](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L128)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`id`](/reference/api/interfaces/conversationsummaryreport/#id)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:132](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L132)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastProgressAt`](/reference/api/interfaces/conversationsummaryreport/#lastprogressat)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:131](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L131)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastSeenAt`](/reference/api/interfaces/conversationsummaryreport/#lastseenat)

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: [junior/src/reporting/conversations.ts:139](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L139)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`sentryTraceUrl`](/reference/api/interfaces/conversationsummaryreport/#sentrytraceurl)

---

### startedAt

> **startedAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:130](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L130)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`startedAt`](/reference/api/interfaces/conversationsummaryreport/#startedat)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: [junior/src/reporting/conversations.ts:129](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L129)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`status`](/reference/api/interfaces/conversationsummaryreport/#status)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: [junior/src/reporting/conversations.ts:134](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L134)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`surface`](/reference/api/interfaces/conversationsummaryreport/#surface)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: [junior/src/reporting/conversations.ts:140](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L140)

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`traceId`](/reference/api/interfaces/conversationsummaryreport/#traceid)

---

### transcript

> **transcript**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: [junior/src/reporting/conversations.ts:192](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L192)

---

### transcriptAvailable

> **transcriptAvailable**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:187](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L187)

---

### transcriptMessageCount?

> `optional` **transcriptMessageCount?**: `number`

Defined in: [junior/src/reporting/conversations.ts:189](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L189)

---

### transcriptMetadata?

> `optional` **transcriptMetadata?**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: [junior/src/reporting/conversations.ts:188](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L188)

---

### transcriptRedacted?

> `optional` **transcriptRedacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:190](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L190)

---

### transcriptRedactionReason?

> `optional` **transcriptRedactionReason?**: `"non_public_conversation"`

Defined in: [junior/src/reporting/conversations.ts:191](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L191)
