---
editUrl: false
next: false
prev: false
title: "pluginSessionContextSchema"
---

> `const` **pluginSessionContextSchema**: `ZodObject`\<\{ `completedAtMs`: `ZodNumber`; `conversationId`: `ZodString`; `destination`: `ZodDiscriminatedUnion`\<\[`ZodObject`\<\{ `channelId`: `ZodString`; `platform`: `ZodLiteral`\<`"slack"`\>; `teamId`: `ZodString`; \}, `$strict`\>, `ZodObject`\<\{ `conversationId`: `ZodString`; `platform`: `ZodLiteral`\<`"local"`\>; \}, `$strict`\>\], `"platform"`\>; `messages`: `ZodArray`\<`ZodObject`\<\{ `role`: `ZodEnum`\<\{ `assistant`: `"assistant"`; `user`: `"user"`; \}\>; `text`: `ZodString`; \}, `$strict`\>\>; `requester`: `ZodOptional`\<`ZodDiscriminatedUnion`\<\[`ZodObject`\<\{ `email`: `ZodOptional`\<`ZodString`\>; `fullName`: `ZodOptional`\<`ZodString`\>; `platform`: `ZodLiteral`\<`"slack"`\>; `teamId`: `ZodString`; `userId`: `ZodString`; `userName`: `ZodOptional`\<`ZodString`\>; \}, `$strict`\>, `ZodObject`\<\{ `email`: `ZodOptional`\<`ZodString`\>; `fullName`: `ZodOptional`\<`ZodString`\>; `platform`: `ZodLiteral`\<`"local"`\>; `userId`: `ZodString`; `userName`: `ZodOptional`\<`ZodString`\>; \}, `$strict`\>\], `"platform"`\>\>; `sessionId`: `ZodString`; `source`: `ZodDiscriminatedUnion`\<\[`ZodObject`\<\{ `channelId`: `ZodString`; `messageTs`: `ZodOptional`\<`ZodString`\>; `platform`: `ZodLiteral`\<`"slack"`\>; `teamId`: `ZodString`; `threadTs`: `ZodOptional`\<`ZodString`\>; `type`: `ZodEnum`\<\{ `priv`: `"priv"`; `pub`: `"pub"`; \}\>; \}, `$strict`\>, `ZodObject`\<\{ `conversationId`: `ZodString`; `platform`: `ZodLiteral`\<`"local"`\>; `type`: `ZodLiteral`\<`"priv"`\>; \}, `$strict`\>\], `"platform"`\>; `toolCalls`: `ZodArray`\<`ZodString`\>; \}, `$strict`\>

Defined in: [junior-plugin-api/src/tasks.ts:21](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L21)

Runtime-owned completed-session projection exposed to plugin tasks.
