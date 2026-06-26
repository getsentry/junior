---
editUrl: false
next: false
prev: false
title: "pluginSessionMessageSchema"
---

> `const` **pluginSessionMessageSchema**: `ZodObject`\<\{ `role`: `ZodEnum`\<\{ `assistant`: `"assistant"`; `user`: `"user"`; \}\>; `text`: `ZodString`; \}, `$strict`\>

Defined in: [junior-plugin-api/src/tasks.ts:13](https://github.com/getsentry/junior/blob/main/packages/junior-plugin-api/src/tasks.ts#L13)

Bounded message projection exposed by completed-session plugin tasks.
