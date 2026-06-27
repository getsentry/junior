---
editUrl: false
next: false
prev: false
title: "pluginRunTranscriptEntrySchema"
---

> `const` **pluginRunTranscriptEntrySchema**: `ZodDiscriminatedUnion`\<\[`ZodObject`\<\{ `role`: `ZodEnum`\<\{ `assistant`: `"assistant"`; `user`: `"user"`; \}\>; `text`: `ZodString`; `type`: `ZodLiteral`\<`"message"`\>; \}, `$strict`\>, `ZodObject`\<\{ `isError`: `ZodBoolean`; `text`: `ZodOptional`\<`ZodString`\>; `toolName`: `ZodString`; `type`: `ZodLiteral`\<`"toolResult"`\>; \}, `$strict`\>\], `"type"`\>

Defined in: [junior-plugin-api/src/tasks.ts:13](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L13)

One normalized transcript entry from the completed run exposed to plugin tasks.
