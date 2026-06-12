---
editUrl: false
next: false
prev: false
title: "juniorVercelConfig"
---

> **juniorVercelConfig**(`options?`): `Record`\<`string`, `unknown`\>

Defined in: [junior/src/vercel.ts:11](https://github.com/getsentry/junior/blob/main/packages/junior/src/vercel.ts#L11)

Return the root Vercel project config for scaffolded Junior apps.

New apps run `junior upgrade` before `pnpm build`; older installs without
Junior SQL configured can override `buildCommand` to keep their prior build.

## Parameters

### options?

[`JuniorVercelConfigOptions`](/reference/api/interfaces/juniorvercelconfigoptions/) = `{}`

## Returns

`Record`\<`string`, `unknown`\>
