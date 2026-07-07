---
editUrl: false
next: false
prev: false
title: "ConversationToolActivityReport"
---

Defined in: [junior/src/reporting/conversations.ts:221](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L221)

## Extends

- `ActivityPayloadMetadata`

## Properties

### args?

> `optional` **args?**: `unknown`

Defined in: [junior/src/reporting/conversations.ts:223](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L223)

---

### createdAt

> **createdAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:224](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L224)

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:225](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L225)

---

### inputKeys?

> `optional` **inputKeys?**: `string`[]

Defined in: [junior/src/reporting/conversations.ts:203](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L203)

#### Inherited from

`ActivityPayloadMetadata.inputKeys`

---

### inputSizeBytes?

> `optional` **inputSizeBytes?**: `number`

Defined in: [junior/src/reporting/conversations.ts:204](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L204)

#### Inherited from

`ActivityPayloadMetadata.inputSizeBytes`

---

### inputSizeChars?

> `optional` **inputSizeChars?**: `number`

Defined in: [junior/src/reporting/conversations.ts:205](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L205)

#### Inherited from

`ActivityPayloadMetadata.inputSizeChars`

---

### inputType?

> `optional` **inputType?**: `string`

Defined in: [junior/src/reporting/conversations.ts:206](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L206)

#### Inherited from

`ActivityPayloadMetadata.inputType`

---

### redacted?

> `optional` **redacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:226](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L226)

---

### status

> **status**: [`ConversationActivityStatus`](/reference/api/type-aliases/conversationactivitystatus/)

Defined in: [junior/src/reporting/conversations.ts:227](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L227)

---

### subagents

> **subagents**: [`ConversationSubagentActivityReport`](/reference/api/interfaces/conversationsubagentactivityreport/)[]

Defined in: [junior/src/reporting/conversations.ts:228](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L228)

---

### toolCallId

> **toolCallId**: `string`

Defined in: [junior/src/reporting/conversations.ts:229](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L229)

---

### toolName

> **toolName**: `string`

Defined in: [junior/src/reporting/conversations.ts:230](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L230)

---

### type

> **type**: `"tool_execution"`

Defined in: [junior/src/reporting/conversations.ts:222](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L222)
