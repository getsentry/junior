---
editUrl: false
next: false
prev: false
title: "runtimeInfoReportSchema"
---

> `const` **runtimeInfoReportSchema**: `ZodObject`\<\{ `cwd`: `ZodString`; `descriptionText`: `ZodOptional`\<`ZodString`\>; `homeDir`: `ZodString`; `packagedContent`: `ZodObject`\<\{ `manifestRoots`: `ZodArray`\<`ZodString`\>; `packageNames`: `ZodArray`\<`ZodString`\>; `packages`: `ZodArray`\<`ZodObject`\<\{ `dir`: `ZodString`; `hasMigrationsDir`: `ZodBoolean`; `hasSkillsDir`: `ZodBoolean`; `packageName`: `ZodString`; \}, `$strict`\>\>; `skillRoots`: `ZodArray`\<`ZodString`\>; `tracingIncludes`: `ZodArray`\<`ZodString`\>; \}, `$strict`\>; `providers`: `ZodArray`\<`ZodString`\>; `skills`: `ZodArray`\<`ZodObject`\<\{ `name`: `ZodString`; `pluginProvider`: `ZodOptional`\<`ZodString`\>; \}, `$strict`\>\>; \}, `$strict`\>

Defined in: junior/src/reporting-schema.ts:41
