---
editUrl: false
next: false
prev: false
title: "conversationFeedSchema"
---

> `const` **conversationFeedSchema**: `ZodObject`\<\{ `conversations`: `ZodArray`\<`ZodObject`\<\{ `actorIdentity`: `ZodOptional`\<`ZodObject`\<\{ `email`: `ZodOptional`\<`ZodString`\>; `fullName`: `ZodOptional`\<`ZodString`\>; `slackUserId`: `ZodOptional`\<`ZodString`\>; `slackUserName`: `ZodOptional`\<`ZodString`\>; \}, `$strict`\>\>; `channel`: `ZodOptional`\<`ZodString`\>; `channelName`: `ZodOptional`\<`ZodString`\>; `channelNameRedacted`: `ZodOptional`\<`ZodBoolean`\>; `conversationId`: `ZodString`; `cumulativeDurationMs`: `ZodNumber`; `cumulativeUsage`: `ZodOptional`\<`ZodObject`\<\{ `cacheCreationTokens`: `ZodOptional`\<`ZodNumber`\>; `cachedInputTokens`: `ZodOptional`\<`ZodNumber`\>; `cost`: `ZodOptional`\<`ZodObject`\<\{ `cacheRead`: ...; `cacheWrite`: ...; `input`: ...; `output`: ...; `total`: ...; \}, `$strict`\>\>; `inputTokens`: `ZodOptional`\<`ZodNumber`\>; `outputTokens`: `ZodOptional`\<`ZodNumber`\>; `reasoningTokens`: `ZodOptional`\<`ZodNumber`\>; `totalTokens`: `ZodOptional`\<`ZodNumber`\>; \}, `$strict`\>\>; `displayTitle`: `ZodString`; `lastProgressAt`: `ZodString`; `lastSeenAt`: `ZodString`; `locationId`: `ZodOptional`\<`ZodString`\>; `sentryTraceUrl`: `ZodOptional`\<`ZodString`\>; `startedAt`: `ZodString`; `status`: `ZodEnum`\<\{ `active`: `"active"`; `completed`: `"completed"`; `failed`: `"failed"`; \}\>; `surface`: `ZodEnum`\<\{ `api`: `"api"`; `internal`: `"internal"`; `scheduler`: `"scheduler"`; `slack`: `"slack"`; \}\>; `traceId`: `ZodOptional`\<`ZodString`\>; \}, `$strict`\>\>; `generatedAt`: `ZodString`; `source`: `ZodLiteral`\<`"conversation_index"`\>; \}, `$strict`\>

Defined in: [junior/src/api/conversations/schema.ts:214](https://github.com/getsentry/junior/blob/main/packages/junior/src/api/conversations/schema.ts#L214)
