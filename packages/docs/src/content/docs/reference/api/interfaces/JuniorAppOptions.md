---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [app.ts:48](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L48)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [app.ts:50](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L50)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

***

### plugins?

> `optional` **plugins?**: [`JuniorPluginSet`](/reference/api/interfaces/juniorpluginset/)

Defined in: [app.ts:52](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L52)

Direct plugin set override. Usually omitted when `juniorNitro()` uses a plugin module.

***

### waitUntil?

> `optional` **waitUntil?**: `WaitUntilFn`

Defined in: [app.ts:53](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L53)
