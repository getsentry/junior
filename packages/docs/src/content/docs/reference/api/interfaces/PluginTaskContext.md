---
editUrl: false
next: false
prev: false
title: "PluginTaskContext"
---

Defined in: [junior-plugin-api/src/tasks.ts:82](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L82)

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

Defined in: [junior-plugin-api/src/tasks.ts:83](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L83)

---

### id

> **id**: `string`

Defined in: [junior-plugin-api/src/tasks.ts:84](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L84)

---

### log

> **log**: `PluginLogger`

Defined in: [junior-plugin-api/src/context.ts:63](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L63)

#### Inherited from

`PluginContext.log`

---

### model

> **model**: `PluginModel`

Defined in: [junior-plugin-api/src/tasks.ts:85](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L85)

---

### name

> **name**: `string`

Defined in: [junior-plugin-api/src/tasks.ts:86](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L86)

---

### plugin

> **plugin**: `PluginMetadata`

Defined in: [junior-plugin-api/src/context.ts:64](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/context.ts#L64)

#### Inherited from

`PluginContext.plugin`

---

### run

> **run**: `object`

Defined in: [junior-plugin-api/src/tasks.ts:87](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L87)

#### load()

> **load**(): `Promise`\<\{ `actor?`: \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \} \| \{ `name`: `string`; `platform`: `"system"`; \}; `actors`: (\{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \} \| \{ `name`: `string`; `platform`: `"system"`; \})[]; `completedAtMs`: `number`; `conversationId`: `string`; `destination`: \{ `channelId`: `string`; `platform`: `"slack"`; `teamId`: `string`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; \}; `runId`: `string`; `source`: \{ `channelId`: `string`; `messageTs?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `threadTs?`: `string`; `type`: `"pub"` \| `"priv"`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; `type`: `"priv"`; \}; `transcript`: (\{ `isRunActor?`: `boolean`; `provenance?`: \{ `actor?`: \{ `email?`: ... \| ...; `fullName?`: ... \| ...; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: ... \| ...; \} \| \{ `email?`: ... \| ...; `fullName?`: ... \| ...; `platform`: `"local"`; `userId`: `string`; `userName?`: ... \| ...; \} \| \{ `name`: `string`; `platform`: `"system"`; \}; `authority`: `"instruction"` \| `"context"`; \}; `role`: `"assistant"` \| `"user"`; `text`: `string`; `type`: `"message"`; \} \| \{ `isError`: `boolean`; `text?`: `string`; `toolName`: `string`; `type`: `"toolResult"`; \})[]; \}\>

##### Returns

`Promise`\<\{ `actor?`: \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \} \| \{ `name`: `string`; `platform`: `"system"`; \}; `actors`: (\{ `email?`: `string`; `fullName?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: `string`; \} \| \{ `email?`: `string`; `fullName?`: `string`; `platform`: `"local"`; `userId`: `string`; `userName?`: `string`; \} \| \{ `name`: `string`; `platform`: `"system"`; \})[]; `completedAtMs`: `number`; `conversationId`: `string`; `destination`: \{ `channelId`: `string`; `platform`: `"slack"`; `teamId`: `string`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; \}; `runId`: `string`; `source`: \{ `channelId`: `string`; `messageTs?`: `string`; `platform`: `"slack"`; `teamId`: `string`; `threadTs?`: `string`; `type`: `"pub"` \| `"priv"`; \} \| \{ `conversationId`: `string`; `platform`: `"local"`; `type`: `"priv"`; \}; `transcript`: (\{ `isRunActor?`: `boolean`; `provenance?`: \{ `actor?`: \{ `email?`: ... \| ...; `fullName?`: ... \| ...; `platform`: `"slack"`; `teamId`: `string`; `userId`: `string`; `userName?`: ... \| ...; \} \| \{ `email?`: ... \| ...; `fullName?`: ... \| ...; `platform`: `"local"`; `userId`: `string`; `userName?`: ... \| ...; \} \| \{ `name`: `string`; `platform`: `"system"`; \}; `authority`: `"instruction"` \| `"context"`; \}; `role`: `"assistant"` \| `"user"`; `text`: `string`; `type`: `"message"`; \} \| \{ `isError`: `boolean`; `text?`: `string`; `toolName`: `string`; `type`: `"toolResult"`; \})[]; \}\>

---

### state

> **state**: `PluginState`

Defined in: [junior-plugin-api/src/tasks.ts:90](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L90)
