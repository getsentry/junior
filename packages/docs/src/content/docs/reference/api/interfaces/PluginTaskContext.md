---
editUrl: false
next: false
prev: false
title: "PluginTaskContext"
---

Defined in: [junior-plugin-api/src/tasks.ts:39](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L39)

Runtime context passed to a plugin-owned background task.

## Extends

- `PluginContext`

## Properties

### db

> **db**: `unknown`

Defined in: [junior-plugin-api/src/context.ts:60](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L60)

Shared Drizzle database connection for plugin runtime code.

#### Inherited from

`PluginContext.db`

---

### embedder

> **embedder**: `PluginEmbedder`

Defined in: [junior-plugin-api/src/tasks.ts:40](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L40)

---

### id

> **id**: `string`

Defined in: [junior-plugin-api/src/tasks.ts:41](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L41)

---

### log

> **log**: `PluginLogger`

Defined in: [junior-plugin-api/src/context.ts:61](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L61)

#### Inherited from

`PluginContext.log`

---

### model

> **model**: `PluginModel`

Defined in: [junior-plugin-api/src/tasks.ts:42](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L42)

---

### name

> **name**: `string`

Defined in: [junior-plugin-api/src/tasks.ts:43](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L43)

---

### plugin

> **plugin**: `PluginMetadata`

Defined in: [junior-plugin-api/src/context.ts:62](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L62)

#### Inherited from

`PluginContext.plugin`

---

### session

> **session**: `object`

Defined in: [junior-plugin-api/src/tasks.ts:44](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L44)

#### load()

> **load**(): `Promise`\<\{ `completedAtMs`: `number`; `conversationId`: `string`; `destination`: \{ `channelId`: `string`; `platform`: `"slack"`; `teamId`: `string`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; \}; `messages`: `object`[]; `requester`: \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \}; `sessionId`: `string`; `source`: \{ `channelId`: `string`; `messageTs?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `threadTs?`: `string`; `type`: `"pub"` \| `"priv"`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; `type`: `"priv"`; \}; `toolCalls`: `string`[]; \}\>

##### Returns

`Promise`\<\{ `completedAtMs`: `number`; `conversationId`: `string`; `destination`: \{ `channelId`: `string`; `platform`: `"slack"`; `teamId`: `string`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; \}; `messages`: `object`[]; `requester`: \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \}; `sessionId`: `string`; `source`: \{ `channelId`: `string`; `messageTs?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `threadTs?`: `string`; `type`: `"pub"` \| `"priv"`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; `type`: `"priv"`; \}; `toolCalls`: `string`[]; \}\>

---

### state

> **state**: `PluginState`

Defined in: [junior-plugin-api/src/tasks.ts:47](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L47)
