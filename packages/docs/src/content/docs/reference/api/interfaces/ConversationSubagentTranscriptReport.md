---
editUrl: false
next: false
prev: false
title: "ConversationSubagentTranscriptReport"
---

Defined in: junior/src/api/conversations/types.ts:158

## Properties

### createdAt

> **createdAt**: `string`

Defined in: junior/src/api/conversations/types.ts:160

---

### endedAt?

> `optional` **endedAt?**: `string`

Defined in: junior/src/api/conversations/types.ts:161

---

### id

> **id**: `string`

Defined in: junior/src/api/conversations/types.ts:162

---

### modelId?

> `optional` **modelId?**: `string`

Defined in: junior/src/api/conversations/types.ts:163

---

### outcome?

> `optional` **outcome?**: `"error"` \| `"aborted"` \| `"success"`

Defined in: junior/src/api/conversations/types.ts:164

---

### parentToolCallId?

> `optional` **parentToolCallId?**: `string`

Defined in: junior/src/api/conversations/types.ts:165

---

### reasoningLevel?

> `optional` **reasoningLevel?**: `string`

Defined in: junior/src/api/conversations/types.ts:166

---

### status

> **status**: [`ConversationActivityStatus`](/reference/api/type-aliases/conversationactivitystatus/)

Defined in: junior/src/api/conversations/types.ts:167

---

### subagentConversationId?

> `optional` **subagentConversationId?**: `string`

Defined in: junior/src/api/conversations/types.ts:168

---

### subagentKind

> **subagentKind**: `string`

Defined in: junior/src/api/conversations/types.ts:169

---

### subagentSentryConversationUrl?

> `optional` **subagentSentryConversationUrl?**: `string`

Defined in: junior/src/api/conversations/types.ts:170

---

### transcript

> **transcript**: [`TranscriptMessage`](/reference/api/interfaces/transcriptmessage/)[]

Defined in: junior/src/api/conversations/types.ts:171

---

### transcriptAvailable

> **transcriptAvailable**: `boolean`

Defined in: junior/src/api/conversations/types.ts:172

---

### transcriptExpired?

> `optional` **transcriptExpired?**: `boolean`

Defined in: junior/src/api/conversations/types.ts:177

True when retention purged the parent conversation's content.

---

### transcriptExpiredAt?

> `optional` **transcriptExpiredAt?**: `string`

Defined in: junior/src/api/conversations/types.ts:179

When the content was purged (ISO 8601); present only with `transcriptExpired`.

---

### transcriptMessageCount?

> `optional` **transcriptMessageCount?**: `number`

Defined in: junior/src/api/conversations/types.ts:173

---

### transcriptRedacted?

> `optional` **transcriptRedacted?**: `boolean`

Defined in: junior/src/api/conversations/types.ts:174

---

### transcriptRedactionReason?

> `optional` **transcriptRedactionReason?**: `"non_public_conversation"`

Defined in: junior/src/api/conversations/types.ts:175

---

### type

> **type**: `"subagent"`

Defined in: junior/src/api/conversations/types.ts:159

---

### unavailableReason?

> `optional` **unavailableReason?**: `"not_found"` \| `"missing_transcript_range"` \| `"missing_transcript_ref"`

Defined in: junior/src/api/conversations/types.ts:180
