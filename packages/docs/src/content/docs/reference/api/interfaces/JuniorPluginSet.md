---
editUrl: false
next: false
prev: false
title: "JuniorPluginSet"
---

Defined in: [junior/src/plugins.ts:16](https://github.com/getsentry/junior/blob/main/packages/junior/src/plugins.ts#L16)

Reusable plugin registrations and manifest overrides.

## Properties

### manifests?

> `optional` **manifests?**: `Record`\<`string`, `PluginManifestConfig`\>

Defined in: [junior/src/plugins.ts:18](https://github.com/getsentry/junior/blob/main/packages/junior/src/plugins.ts#L18)

Install-level manifest overrides applied before validation.

---

### packageNames

> **packageNames**: `string`[]

Defined in: [junior/src/plugins.ts:20](https://github.com/getsentry/junior/blob/main/packages/junior/src/plugins.ts#L20)

Manifest-only plugin packages included by package name.

---

### registrations

> **registrations**: `JuniorPluginRegistration`[]

Defined in: [junior/src/plugins.ts:22](https://github.com/getsentry/junior/blob/main/packages/junior/src/plugins.ts#L22)

JavaScript plugin definitions included by package factories.
