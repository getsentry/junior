---
editUrl: false
next: false
prev: false
title: "JuniorReporting"
---

Defined in: [junior/src/reporting.ts:92](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L92)

## Methods

### getConversation()

> **getConversation**(`conversationId`): `Promise`\<[`ConversationReport`](/reference/api/interfaces/conversationreport/)\>

Defined in: [junior/src/reporting.ts:118](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L118)

Read one conversation transcript for reporting consumers.

The current implementation joins turn-session records with expiring session
logs, but the API should stay compatible with a future Sentry trace-history
source. Avoid adding fields that require Redis-only transcript internals.

#### Parameters

##### conversationId

`string`

#### Returns

`Promise`\<[`ConversationReport`](/reference/api/interfaces/conversationreport/)\>

---

### getConversationStats()?

> `optional` **getConversationStats**(): `Promise`\<[`ConversationStatsReport`](/reference/api/interfaces/conversationstatsreport/)\>

Defined in: [junior/src/reporting.ts:104](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L104)

Read aggregate conversation stats for reporting consumers.

#### Returns

`Promise`\<[`ConversationStatsReport`](/reference/api/interfaces/conversationstatsreport/)\>

---

### getHealth()

> **getHealth**(): `Promise`\<[`HealthReport`](/reference/api/interfaces/healthreport/)\>

Defined in: [junior/src/reporting.ts:94](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L94)

Read the public runtime health snapshot without exposing discovery data.

#### Returns

`Promise`\<[`HealthReport`](/reference/api/interfaces/healthreport/)\>

---

### getPluginOperationalReports()?

> `optional` **getPluginOperationalReports**(): `Promise`\<[`PluginOperationalReportFeed`](/reference/api/interfaces/pluginoperationalreportfeed/)\>

Defined in: [junior/src/reporting.ts:110](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L110)

Read sanitized operational summaries contributed by plugins.

#### Returns

`Promise`\<[`PluginOperationalReportFeed`](/reference/api/interfaces/pluginoperationalreportfeed/)\>

---

### getPlugins()

> **getPlugins**(): `Promise`\<[`PluginReport`](/reference/api/interfaces/pluginreport/)[]\>

Defined in: [junior/src/reporting.ts:98](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L98)

Read configured plugin names for reporting consumers.

#### Returns

`Promise`\<[`PluginReport`](/reference/api/interfaces/pluginreport/)[]\>

---

### getRuntimeInfo()

> **getRuntimeInfo**(): `Promise`\<[`RuntimeInfoReport`](/reference/api/interfaces/runtimeinforeport/)\>

Defined in: [junior/src/reporting.ts:96](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L96)

Read authenticated runtime discovery data for reporting consumers.

#### Returns

`Promise`\<[`RuntimeInfoReport`](/reference/api/interfaces/runtimeinforeport/)\>

---

### getSessions()

> **getSessions**(): `Promise`\<[`ConversationFeed`](/reference/api/interfaces/conversationfeed/)\>

Defined in: [junior/src/reporting.ts:102](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L102)

Read recent conversation summaries for reporting consumers.

#### Returns

`Promise`\<[`ConversationFeed`](/reference/api/interfaces/conversationfeed/)\>

---

### getSkills()

> **getSkills**(): `Promise`\<[`SkillReport`](/reference/api/interfaces/skillreport/)[]\>

Defined in: [junior/src/reporting.ts:100](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L100)

Read discovered skill names for reporting consumers.

#### Returns

`Promise`\<[`SkillReport`](/reference/api/interfaces/skillreport/)[]\>

---

### listRecentConversations()?

> `optional` **listRecentConversations**(`options?`): `Promise`\<[`PluginConversationSummary`](/reference/api/interfaces/pluginconversationsummary/)[]\>

Defined in: [junior/src/reporting.ts:106](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L106)

Read recent conversation summaries without transcript payloads.

#### Parameters

##### options?

###### limit?

`number`

#### Returns

`Promise`\<[`PluginConversationSummary`](/reference/api/interfaces/pluginconversationsummary/)[]\>
