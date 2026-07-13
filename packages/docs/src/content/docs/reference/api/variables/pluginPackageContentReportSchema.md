---
editUrl: false
next: false
prev: false
title: "pluginPackageContentReportSchema"
---

> `const` **pluginPackageContentReportSchema**: `ZodObject`\<\{ `manifestRoots`: `ZodArray`\<`ZodString`\>; `packageNames`: `ZodArray`\<`ZodString`\>; `packages`: `ZodArray`\<`ZodObject`\<\{ `dir`: `ZodString`; `hasMigrationsDir`: `ZodBoolean`; `hasSkillsDir`: `ZodBoolean`; `packageName`: `ZodString`; \}, `$strict`\>\>; `skillRoots`: `ZodArray`\<`ZodString`\>; `tracingIncludes`: `ZodArray`\<`ZodString`\>; \}, `$strict`\>

Defined in: [junior/src/reporting-schema.ts:31](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting-schema.ts#L31)
