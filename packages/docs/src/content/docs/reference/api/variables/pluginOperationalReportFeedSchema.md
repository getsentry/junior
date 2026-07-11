---
editUrl: false
next: false
prev: false
title: "pluginOperationalReportFeedSchema"
---

> `const` **pluginOperationalReportFeedSchema**: `ZodObject`\<\{ `generatedAt`: `ZodString`; `reports`: `ZodArray`\<`ZodObject`\<\{ `generatedAt`: `ZodOptional`\<`ZodString`\>; `metrics`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `label`: `ZodString`; `tone`: `ZodOptional`\<`ZodEnum`\<...\>\>; `value`: `ZodString`; \}, `$strict`\>\>\>; `pluginName`: `ZodString`; `recordSets`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `emptyText`: `ZodOptional`\<`ZodString`\>; `fields`: `ZodOptional`\<`ZodArray`\<...\>\>; `records`: `ZodOptional`\<`ZodArray`\<...\>\>; `title`: `ZodString`; \}, `$strict`\>\>\>; `title`: `ZodOptional`\<`ZodString`\>; \}, `$strict`\>\>; `source`: `ZodLiteral`\<`"plugins"`\>; \}, `$strict`\>

Defined in: junior/src/reporting-schema.ts:101
