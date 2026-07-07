---
editUrl: false
next: false
prev: false
title: "PluginTaskContext"
---

Defined in: [junior-plugin-api/src/tasks.ts:51](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L51)

Runtime context passed to a plugin-owned background task.

## Extends

- `PluginContext`

## Properties

### db

> **db**: `unknown`

Defined in: [junior-plugin-api/src/context.ts:62](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L62)

Shared Drizzle database connection for plugin runtime code.

#### Inherited from

`PluginContext.db`

---

### embedder

> **embedder**: `PluginEmbedder`

Defined in: [junior-plugin-api/src/tasks.ts:52](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L52)

---

### id

> **id**: `string`

Defined in: [junior-plugin-api/src/tasks.ts:53](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L53)

---

### log

> **log**: `PluginLogger`

Defined in: [junior-plugin-api/src/context.ts:63](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L63)

#### Inherited from

`PluginContext.log`

---

### model

> **model**: `PluginModel`

Defined in: [junior-plugin-api/src/tasks.ts:54](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L54)

---

### name

> **name**: `string`

Defined in: [junior-plugin-api/src/tasks.ts:55](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L55)

---

### plugin

> **plugin**: `PluginMetadata`

Defined in: [junior-plugin-api/src/context.ts:64](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L64)

#### Inherited from

`PluginContext.plugin`

---

### run

> **run**: `object`

Defined in: [junior-plugin-api/src/tasks.ts:56](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L56)

#### load()

> **load**(): `Promise`\<\{ `actor`: \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \} \| \{ `name`: `string`; `platform`: `"system"`; \}; `completedAtMs`: `number`; `conversationId`: `string`; `destination`: \{ `channelId`: `string`; `platform`: `"slack"`; `teamId`: `string`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; \}; `runId`: `string`; `source`: \{ `channelId`: `string`; `messageTs?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `threadTs?`: `string`; `type`: `"pub"` \| `"priv"`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; `type`: `"priv"`; \}; `transcript`: (\{ `role`: `"user"` \| `"assistant"`; `text`: `string`; `type`: `"message"`; \} \| \{ `isError`: `boolean`; `text?`: `string`; `toolName`: `string`; `type`: `"toolResult"`; \})[]; \}\>

##### Returns

`Promise`\<\{ `actor`: \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \} \| \{ `name`: `string`; `platform`: `"system"`; \}; `completedAtMs`: `number`; `conversationId`: `string`; `destination`: \{ `channelId`: `string`; `platform`: `"slack"`; `teamId`: `string`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; \}; `runId`: `string`; `source`: \{ `channelId`: `string`; `messageTs?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `threadTs?`: `string`; `type`: `"pub"` \| `"priv"`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; `type`: `"priv"`; \}; `transcript`: (\{ `role`: `"user"` \| `"assistant"`; `text`: `string`; `type`: `"message"`; \} \| \{ `isError`: `boolean`; `text?`: `string`; `toolName`: `string`; `type`: `"toolResult"`; \})[]; \}\>

---

### state

> **state**: `PluginState`

Defined in: [junior-plugin-api/src/tasks.ts:59](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L59)
