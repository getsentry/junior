---
editUrl: false
next: false
prev: false
title: "JuniorPluginSet"
---

Defined in: plugins.ts:16

Reusable plugin registrations and manifest overrides.

## Properties

### manifests?

> `optional` **manifests?**: `Record`\<`string`, `PluginManifestConfig`\>

Defined in: plugins.ts:18

Install-level manifest overrides applied before validation.

---

### packageNames

> **packageNames**: `string`[]

Defined in: plugins.ts:20

Manifest-only plugin packages included by package name.

---

### registrations

> **registrations**: `JuniorPluginRegistration`[]

Defined in: plugins.ts:22

JavaScript plugin definitions included by package factories.
