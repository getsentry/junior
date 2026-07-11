---
editUrl: false
next: false
prev: false
title: "ConversationRunReport"
---

Defined in: junior/src/api/conversations/types.ts:88

## Extends

- [`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/)

## Properties

### activity?

> `optional` **activity?**: [`ConversationActivityReport`](/reference/api/type-aliases/conversationactivityreport/)[]

Defined in: junior/src/api/conversations/types.ts:89

---

### actorIdentity?

> `optional` **actorIdentity?**: [`ActorIdentity`](/reference/api/interfaces/actoridentity/)

Defined in: junior/src/api/conversations/types.ts:38

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`actorIdentity`](/reference/api/interfaces/conversationsummaryreport/#actoridentity)

---

### channel?

> `optional` **channel?**: `string`

Defined in: junior/src/api/conversations/types.ts:39

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channel`](/reference/api/interfaces/conversationsummaryreport/#channel)

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: junior/src/api/conversations/types.ts:40

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channelName`](/reference/api/interfaces/conversationsummaryreport/#channelname)

---

### channelNameRedacted?

> `optional` **channelNameRedacted?**: `boolean`

Defined in: junior/src/api/conversations/types.ts:41

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`channelNameRedacted`](/reference/api/interfaces/conversationsummaryreport/#channelnameredacted)

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: junior/src/api/conversations/types.ts:36

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`completedAt`](/reference/api/interfaces/conversationsummaryreport/#completedat)

---

### conversationId

> **conversationId**: `string`

Defined in: junior/src/api/conversations/types.ts:30

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`conversationId`](/reference/api/interfaces/conversationsummaryreport/#conversationid)

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: junior/src/api/conversations/types.ts:28

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeDurationMs`](/reference/api/interfaces/conversationsummaryreport/#cumulativedurationms)

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: junior/src/api/conversations/types.ts:29

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`cumulativeUsage`](/reference/api/interfaces/conversationsummaryreport/#cumulativeusage)

---

### displayTitle

> **displayTitle**: `string`

Defined in: junior/src/api/conversations/types.ts:27

Always-populated display title, with privacy redaction applied first.

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`displayTitle`](/reference/api/interfaces/conversationsummaryreport/#displaytitle)

---

### id

> **id**: `string`

Defined in: junior/src/api/conversations/types.ts:31

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`id`](/reference/api/interfaces/conversationsummaryreport/#id)

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: junior/src/api/conversations/types.ts:35

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastProgressAt`](/reference/api/interfaces/conversationsummaryreport/#lastprogressat)

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: junior/src/api/conversations/types.ts:34

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`lastSeenAt`](/reference/api/interfaces/conversationsummaryreport/#lastseenat)

---

### modelId?

> `optional` **modelId?**: `string`

Defined in: junior/src/api/conversations/types.ts:90

---

### reasoningLevel?

> `optional` **reasoningLevel?**: `string`

Defined in: junior/src/api/conversations/types.ts:91

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: junior/src/api/conversations/types.ts:42

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`sentryTraceUrl`](/reference/api/interfaces/conversationsummaryreport/#sentrytraceurl)

---

### startedAt

> **startedAt**: `string`

Defined in: junior/src/api/conversations/types.ts:33

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`startedAt`](/reference/api/interfaces/conversationsummaryreport/#startedat)

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: junior/src/api/conversations/types.ts:32

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`status`](/reference/api/interfaces/conversationsummaryreport/#status)

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: junior/src/api/conversations/types.ts:37

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`surface`](/reference/api/interfaces/conversationsummaryreport/#surface)

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: junior/src/api/conversations/types.ts:43

#### Inherited from

[`ConversationSummaryReport`](/reference/api/interfaces/conversationsummaryreport/).[`traceId`](/reference/api/interfaces/conversationsummaryreport/#traceid)

---

### transcript

> **transcript**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: junior/src/api/conversations/types.ts:105

---

### transcriptAvailable

> **transcriptAvailable**: `boolean`

Defined in: junior/src/api/conversations/types.ts:92

---

### transcriptExpired?

> `optional` **transcriptExpired?**: `boolean`

Defined in: junior/src/api/conversations/types.ts:102

True when retention purged this conversation's content. Expiry under
retention is distinct from privacy redaction: the content aged out and was
deleted, so no metadata is derived from it (see data-redaction-policy.md).

---

### transcriptExpiredAt?

> `optional` **transcriptExpiredAt?**: `string`

Defined in: junior/src/api/conversations/types.ts:104

When the content was purged (ISO 8601); present only with `transcriptExpired`.

---

### transcriptMessageCount?

> `optional` **transcriptMessageCount?**: `number`

Defined in: junior/src/api/conversations/types.ts:94

---

### transcriptMetadata?

> `optional` **transcriptMetadata?**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: junior/src/api/conversations/types.ts:93

---

### transcriptRedacted?

> `optional` **transcriptRedacted?**: `boolean`

Defined in: junior/src/api/conversations/types.ts:95

---

### transcriptRedactionReason?

> `optional` **transcriptRedactionReason?**: `"non_public_conversation"`

Defined in: junior/src/api/conversations/types.ts:96
