---
editUrl: false
next: false
prev: false
title: "ConversationToolActivityReport"
---

Defined in: [junior/src/reporting/conversations.ts:201](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L201)

## Extends

- `ActivityPayloadMetadata`

## Properties

### args?

> `optional` **args?**: `unknown`

Defined in: [junior/src/reporting/conversations.ts:203](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L203)

---

### createdAt

> **createdAt**: `string`

Defined in: [junior/src/reporting/conversations.ts:204](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L204)

---

### id

> **id**: `string`

Defined in: [junior/src/reporting/conversations.ts:205](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L205)

---

### inputKeys?

> `optional` **inputKeys?**: `string`[]

Defined in: [junior/src/reporting/conversations.ts:184](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L184)

#### Inherited from

`ActivityPayloadMetadata.inputKeys`

---

### inputSizeBytes?

> `optional` **inputSizeBytes?**: `number`

Defined in: [junior/src/reporting/conversations.ts:185](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L185)

#### Inherited from

`ActivityPayloadMetadata.inputSizeBytes`

---

### inputSizeChars?

> `optional` **inputSizeChars?**: `number`

Defined in: [junior/src/reporting/conversations.ts:186](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L186)

#### Inherited from

`ActivityPayloadMetadata.inputSizeChars`

---

### inputType?

> `optional` **inputType?**: `string`

Defined in: [junior/src/reporting/conversations.ts:187](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L187)

#### Inherited from

`ActivityPayloadMetadata.inputType`

---

### redacted?

> `optional` **redacted?**: `boolean`

Defined in: [junior/src/reporting/conversations.ts:206](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L206)

---

### status

> **status**: [`ConversationActivityStatus`](/reference/api/type-aliases/conversationactivitystatus/)

Defined in: [junior/src/reporting/conversations.ts:207](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L207)

---

### subagents

> **subagents**: [`ConversationSubagentActivityReport`](/reference/api/interfaces/conversationsubagentactivityreport/)[]

Defined in: [junior/src/reporting/conversations.ts:208](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L208)

---

### toolCallId

> **toolCallId**: `string`

Defined in: [junior/src/reporting/conversations.ts:209](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L209)

---

### toolName

> **toolName**: `string`

Defined in: [junior/src/reporting/conversations.ts:210](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L210)

---

### type

> **type**: `"tool_execution"`

Defined in: [junior/src/reporting/conversations.ts:202](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting/conversations.ts#L202)
