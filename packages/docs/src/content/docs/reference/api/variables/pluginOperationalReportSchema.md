---
editUrl: false
next: false
prev: false
title: "pluginOperationalReportSchema"
---

> `const` **pluginOperationalReportSchema**: `ZodObject`\<\{ `generatedAt`: `ZodOptional`\<`ZodString`\>; `metrics`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `label`: `ZodString`; `tone`: `ZodOptional`\<`ZodEnum`\<\{ `danger`: `"danger"`; `good`: `"good"`; `neutral`: `"neutral"`; `warning`: `"warning"`; \}\>\>; `value`: `ZodString`; \}, `$strict`\>\>\>; `pluginName`: `ZodString`; `recordSets`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `emptyText`: `ZodOptional`\<`ZodString`\>; `fields`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `key`: `ZodString`; `label`: `ZodString`; \}, `$strict`\>\>\>; `records`: `ZodOptional`\<`ZodArray`\<`ZodObject`\<\{ `id`: `ZodString`; `tone`: `ZodOptional`\<...\>; `values`: `ZodRecord`\<..., ...\>; \}, `$strict`\>\>\>; `title`: `ZodString`; \}, `$strict`\>\>\>; `title`: `ZodOptional`\<`ZodString`\>; \}, `$strict`\>

Defined in: junior/src/reporting-schema.ts:91
