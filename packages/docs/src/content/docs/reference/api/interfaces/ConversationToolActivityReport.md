---
editUrl: false
next: false
prev: false
title: "ConversationToolActivityReport"
---

Defined in: [junior/src/reporting/conversations.ts:202](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L202)

## Extends

- `ActivityPayloadMetadata`

## Properties

### args?

> `optional` **args?**: `unknown`

Defined in: [junior/src/reporting/conversations.ts:204](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L204)

---

### createdAt

> **createdAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:205](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L205)

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:206](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L206)

---

### inputKeys?

> `optional` **inputKeys?**: `string`[]

Defined in: [junior/src/reporting/conversations.ts:185](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L185)

#### Inherited from

`ActivityPayloadMetadata.inputKeys`

---

### inputSizeBytes?

> `optional` **inputSizeBytes?**: `number`

Defined in: [junior/src/reporting/conversations.ts:186](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L186)

#### Inherited from

`ActivityPayloadMetadata.inputSizeBytes`

---

### inputSizeChars?

> `optional` **inputSizeChars?**: `number`

Defined in: [junior/src/reporting/conversations.ts:187](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L187)

#### Inherited from

`ActivityPayloadMetadata.inputSizeChars`

---

### inputType?

> `optional` **inputType?**: `string`

Defined in: [junior/src/reporting/conversations.ts:188](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L188)

#### Inherited from

`ActivityPayloadMetadata.inputType`

---

### redacted?

> `optional` **redacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:207](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L207)

---

### status

> **status**: [`ConversationActivityStatus`](/reference/api/type-aliases/conversationactivitystatus/)

Defined in: [junior/src/reporting/conversations.ts:208](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L208)

---

### subagents

> **subagents**: [`ConversationSubagentActivityReport`](/reference/api/interfaces/conversationsubagentactivityreport/)[]

Defined in: [junior/src/reporting/conversations.ts:209](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L209)

---

### toolCallId

> **toolCallId**: `string`

Defined in: [junior/src/reporting/conversations.ts:210](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L210)

---

### toolName

> **toolName**: `string`

Defined in: [junior/src/reporting/conversations.ts:211](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L211)

---

### type

> **type**: `"tool_execution"`

Defined in: [junior/src/reporting/conversations.ts:203](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L203)
