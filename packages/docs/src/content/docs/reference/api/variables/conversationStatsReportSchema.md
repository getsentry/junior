---
editUrl: false
next: false
prev: false
title: "conversationStatsReportSchema"
---

> `const` **conversationStatsReportSchema**: `ZodObject`\<\{ `active`: `ZodNumber`; `actors`: `ZodArray`\<`ZodObject`\<\{ `active`: `ZodNumber`; `conversations`: `ZodNumber`; `costUsd`: `ZodOptional`\<`ZodNumber`\>; `durationMs`: `ZodNumber`; `failed`: `ZodNumber`; `label`: `ZodString`; `tokens`: `ZodOptional`\<`ZodNumber`\>; \}, `$strict`\>\>; `conversations`: `ZodNumber`; `costUsd`: `ZodOptional`\<`ZodNumber`\>; `durationMs`: `ZodNumber`; `failed`: `ZodNumber`; `generatedAt`: `ZodString`; `locations`: `ZodArray`\<`ZodObject`\<\{ `active`: `ZodNumber`; `conversations`: `ZodNumber`; `costUsd`: `ZodOptional`\<`ZodNumber`\>; `durationMs`: `ZodNumber`; `failed`: `ZodNumber`; `label`: `ZodString`; `tokens`: `ZodOptional`\<`ZodNumber`\>; \}, `$strict`\>\>; `source`: `ZodLiteral`\<`"conversation_index"`\>; `tokens`: `ZodOptional`\<`ZodNumber`\>; `windowEnd`: `ZodString`; `windowStart`: `ZodString`; \}, `$strict`\>

Defined in: [junior/src/api/conversations/schema.ts:234](https://github.com/getsentry/junior/blob/main/packages/junior/src/api/conversations/schema.ts#L234)
