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

Defined in: [junior-plugin-api/src/context.ts:61](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L61)

Shared Drizzle database connection for plugin runtime code.

#### Inherited from

`PluginContext.db`

---

### id

> **id**: `string`

Defined in: [junior-plugin-api/src/tasks.ts:40](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L40)

---

### log

> **log**: `PluginLogger`

Defined in: [junior-plugin-api/src/context.ts:62](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L62)

#### Inherited from

`PluginContext.log`

---

### name

> **name**: `string`

Defined in: [junior-plugin-api/src/tasks.ts:41](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L41)

---

### plugin

> **plugin**: `PluginMetadata`

Defined in: [junior-plugin-api/src/context.ts:63](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L63)

#### Inherited from

`PluginContext.plugin`

---

### session

> **session**: `object`

Defined in: [junior-plugin-api/src/tasks.ts:42](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L42)

#### load()

> **load**(): `Promise`\<\{ `completedAtMs`: `number`; `conversationId`: `string`; `destination`: \{ `channelId`: `string`; `platform`: `"slack"`; `teamId`: `string`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; \}; `messages`: `object`[]; `requester?`: \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \}; `sessionId`: `string`; `source`: \{ `channelId`: `string`; `messageTs?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `threadTs?`: `string`; `type`: `"pub"` \| `"priv"`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; `type`: `"priv"`; \}; `toolCalls`: `string`[]; \}\>

##### Returns

`Promise`\<\{ `completedAtMs`: `number`; `conversationId`: `string`; `destination`: \{ `channelId`: `string`; `platform`: `"slack"`; `teamId`: `string`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; \}; `messages`: `object`[]; `requester?`: \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \}; `sessionId`: `string`; `source`: \{ `channelId`: `string`; `messageTs?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `threadTs?`: `string`; `type`: `"pub"` \| `"priv"`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; `type`: `"priv"`; \}; `toolCalls`: `string`[]; \}\>

---

### state

> **state**: `PluginState`

Defined in: [junior-plugin-api/src/tasks.ts:45](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L45)
