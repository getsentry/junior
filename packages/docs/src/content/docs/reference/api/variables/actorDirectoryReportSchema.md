---
editUrl: false
next: false
prev: false
title: "actorDirectoryReportSchema"
---

> `const` **actorDirectoryReportSchema**: `ZodObject`\<\{ `generatedAt`: `ZodString`; `people`: `ZodArray`\<`ZodObject`\<\{ `active`: `ZodNumber`; `activeDays`: `ZodNumber`; `actor`: `ZodObject`\<\{ `email`: `ZodString`; `fullName`: `ZodOptional`\<`ZodString`\>; `slackUserId`: `ZodOptional`\<`ZodString`\>; `slackUserName`: `ZodOptional`\<`ZodString`\>; \}, `$strict`\>; `conversations`: `ZodNumber`; `durationMs`: `ZodNumber`; `failed`: `ZodNumber`; `firstSeenAt`: `ZodString`; `hung`: `ZodNumber`; `lastSeenAt`: `ZodString`; `tokens`: `ZodOptional`\<`ZodNumber`\>; \}, `$strict`\>\>; `sampleLimit`: `ZodNumber`; `sampleSize`: `ZodNumber`; `source`: `ZodLiteral`\<`"conversation_index"`\>; `truncated`: `ZodBoolean`; \}, `$strict`\>

Defined in: junior/src/api/people/schema.ts:54
