---
editUrl: false
next: false
prev: false
title: "pluginRunTranscriptEntrySchema"
---

> `const` **pluginRunTranscriptEntrySchema**: `ZodDiscriminatedUnion`\<\[`ZodObject`\<\{ `isRunActor`: `ZodOptional`\<`ZodBoolean`\>; `provenance`: `ZodOptional`\<`ZodObject`\<\{ `actor`: `ZodOptional`\<`ZodDiscriminatedUnion`\<\[`ZodObject`\<..., ...\>, `ZodObject`\<..., ...\>, `ZodObject`\<..., ...\>\], `"platform"`\>\>; `authority`: `ZodEnum`\<\{ `context`: `"context"`; `instruction`: `"instruction"`; \}\>; \}, `$strict`\>\>; `role`: `ZodEnum`\<\{ `assistant`: `"assistant"`; `user`: `"user"`; \}\>; `text`: `ZodString`; `type`: `ZodLiteral`\<`"message"`\>; \}, `$strict`\>, `ZodObject`\<\{ `isError`: `ZodBoolean`; `text`: `ZodOptional`\<`ZodString`\>; `toolName`: `ZodString`; `type`: `ZodLiteral`\<`"toolResult"`\>; \}, `$strict`\>\], `"type"`\>

Defined in: [junior-plugin-api/src/tasks.ts:25](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L25)

One normalized transcript entry from the completed run exposed to plugin tasks.
