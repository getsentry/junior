---
editUrl: false
next: false
prev: false
title: "JuniorAppOptions"
---

Defined in: [app.ts:46](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L46)

## Properties

### configDefaults?

> `optional` **configDefaults?**: `Record`\<`string`, `unknown`\>

Defined in: [app.ts:48](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L48)

Install-wide provider defaults (`provider.key` format). Channel overrides take precedence.

---

### httpInterceptor?

> `optional` **httpInterceptor?**: `SandboxEgressHttpInterceptor`

Defined in: [app.ts:58](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L58)

Intercept credential-injected sandbox HTTP requests before live forwarding.

---

### plugins?

> `optional` **plugins?**: `PluginConfig` \| `JuniorPlugin`[]

Defined in: [app.ts:56](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L56)

Plugin packages/overrides, or trusted plugin instances loaded by this app.

Use `PluginConfig` for declarative package lists and manifest overrides.
Use `JuniorPlugin[]` for trusted plugin factories such as `githubPlugin()`;
their package config is merged with the catalog bundled by `juniorNitro()`.

---

### waitUntil?

> `optional` **waitUntil?**: `WaitUntilFn`

Defined in: [app.ts:59](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L59)
