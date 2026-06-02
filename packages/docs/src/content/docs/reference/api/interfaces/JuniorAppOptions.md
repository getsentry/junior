---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [app.ts:35](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L35)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [app.ts:37](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L37)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

***

### plugins?

> `optional` **plugins?**: `PluginConfig` \| `JuniorPlugin`[]

Defined in: [app.ts:45](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L45)

Plugin packages/overrides, or trusted plugin instances loaded by this app.

Use `PluginConfig` for declarative package lists and manifest overrides.
Use `JuniorPlugin[]` for trusted plugin factories such as `githubPlugin()`;
their package config is merged with the catalog bundled by `juniorNitro()`.

***

### waitUntil?

> `optional` **waitUntil?**: `WaitUntilFn`

Defined in: [app.ts:46](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L46)
