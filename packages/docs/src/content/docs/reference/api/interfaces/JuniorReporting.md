---
editUrl: false
next: false
prev: false
title: "JuniorReporting"
---

Defined in: [junior/src/reporting.ts:58](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L58)

## Methods

### getHealth()

> **getHealth**(): `Promise`\<[`HealthReport`](/reference/api/interfaces/healthreport/)\>

Defined in: [junior/src/reporting.ts:60](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L60)

Read the public runtime health snapshot without exposing discovery data.

#### Returns

`Promise`\<[`HealthReport`](/reference/api/interfaces/healthreport/)\>

---

### getPluginOperationalReports()

> **getPluginOperationalReports**(): `Promise`\<[`PluginOperationalReportFeed`](/reference/api/interfaces/pluginoperationalreportfeed/)\>

Defined in: [junior/src/reporting.ts:68](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L68)

Read sanitized operational summaries contributed by plugins.

#### Returns

`Promise`\<[`PluginOperationalReportFeed`](/reference/api/interfaces/pluginoperationalreportfeed/)\>

---

### getPlugins()

> **getPlugins**(): `Promise`\<[`PluginReport`](/reference/api/interfaces/pluginreport/)[]\>

Defined in: [junior/src/reporting.ts:64](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L64)

Read configured plugin names for reporting consumers.

#### Returns

`Promise`\<[`PluginReport`](/reference/api/interfaces/pluginreport/)[]\>

---

### getRuntimeInfo()

> **getRuntimeInfo**(): `Promise`\<[`RuntimeInfoReport`](/reference/api/interfaces/runtimeinforeport/)\>

Defined in: [junior/src/reporting.ts:62](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L62)

Read authenticated runtime discovery data for reporting consumers.

#### Returns

`Promise`\<[`RuntimeInfoReport`](/reference/api/interfaces/runtimeinforeport/)\>

---

### getSkills()

> **getSkills**(): `Promise`\<[`SkillReport`](/reference/api/interfaces/skillreport/)[]\>

Defined in: [junior/src/reporting.ts:66](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L66)

Read discovered skill names for reporting consumers.

#### Returns

`Promise`\<[`SkillReport`](/reference/api/interfaces/skillreport/)[]\>
