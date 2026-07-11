---
editUrl: false
next: false
prev: false
title: "ConversationSummaryReport"
---

Defined in: junior/src/api/conversations/types.ts:25

## Extended by

- [`ConversationRunReport`](/reference/api/interfaces/conversationrunreport/)

## Properties

### actorIdentity?

> `optional` **actorIdentity?**: [`ActorIdentity`](/reference/api/interfaces/actoridentity/)

Defined in: junior/src/api/conversations/types.ts:38

---

### channel?

> `optional` **channel?**: `string`

Defined in: junior/src/api/conversations/types.ts:39

---

### channelName?

> `optional` **channelName?**: `string`

Defined in: junior/src/api/conversations/types.ts:40

---

### channelNameRedacted?

> `optional` **channelNameRedacted?**: `boolean`

Defined in: junior/src/api/conversations/types.ts:41

---

### completedAt?

> `optional` **completedAt?**: `string`

Defined in: junior/src/api/conversations/types.ts:36

---

### conversationId

> **conversationId**: `string`

Defined in: junior/src/api/conversations/types.ts:30

---

### cumulativeDurationMs

> **cumulativeDurationMs**: `number`

Defined in: junior/src/api/conversations/types.ts:28

---

### cumulativeUsage?

> `optional` **cumulativeUsage?**: [`ConversationUsage`](/reference/api/interfaces/conversationusage/)

Defined in: junior/src/api/conversations/types.ts:29

---

### displayTitle

> **displayTitle**: `string`

Defined in: junior/src/api/conversations/types.ts:27

Always-populated display title, with privacy redaction applied first.

---

### id

> **id**: `string`

Defined in: junior/src/api/conversations/types.ts:31

---

### lastProgressAt

> **lastProgressAt**: `string`

Defined in: junior/src/api/conversations/types.ts:35

---

### lastSeenAt

> **lastSeenAt**: `string`

Defined in: junior/src/api/conversations/types.ts:34

---

### sentryTraceUrl?

> `optional` **sentryTraceUrl?**: `string`

Defined in: junior/src/api/conversations/types.ts:42

---

### startedAt

> **startedAt**: `string`

Defined in: junior/src/api/conversations/types.ts:33

---

### status

> **status**: [`ConversationReportStatus`](/reference/api/type-aliases/conversationreportstatus/)

Defined in: junior/src/api/conversations/types.ts:32

---

### surface

> **surface**: [`ConversationSurface`](/reference/api/type-aliases/conversationsurface/)

Defined in: junior/src/api/conversations/types.ts:37

---

### traceId?

> `optional` **traceId?**: `string`

Defined in: junior/src/api/conversations/types.ts:43
