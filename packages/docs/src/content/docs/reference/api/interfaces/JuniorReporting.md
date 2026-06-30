---
editUrl: false
next: false
prev: false
title: "JuniorReporting"
---

Defined in: [junior/src/reporting.ts:95](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L95)

## Methods

### getConversation()

> **getConversation**(`conversationId`): `Promise`\<[`ConversationReport`](/reference/api/interfaces/conversationreport/)\>

Defined in: [junior/src/reporting.ts:121](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L121)

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

Defined in: [junior/src/reporting.ts:107](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L107)

Read aggregate conversation stats for reporting consumers.

#### Returns

`Promise`\<[`ConversationStatsReport`](/reference/api/interfaces/conversationstatsreport/)\>

---

### getHealth()

> **getHealth**(): `Promise`\<[`HealthReport`](/reference/api/interfaces/healthreport/)\>

Defined in: [junior/src/reporting.ts:97](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L97)

Read the public runtime health snapshot without exposing discovery data.

#### Returns

`Promise`\<[`HealthReport`](/reference/api/interfaces/healthreport/)\>

---

### getPluginOperationalReports()?

> `optional` **getPluginOperationalReports**(): `Promise`\<[`PluginOperationalReportFeed`](/reference/api/interfaces/pluginoperationalreportfeed/)\>

Defined in: [junior/src/reporting.ts:113](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L113)

Read sanitized operational summaries contributed by plugins.

#### Returns

`Promise`\<[`PluginOperationalReportFeed`](/reference/api/interfaces/pluginoperationalreportfeed/)\>

---

### getPlugins()

> **getPlugins**(): `Promise`\<[`PluginReport`](/reference/api/interfaces/pluginreport/)[]\>

Defined in: [junior/src/reporting.ts:101](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L101)

Read configured plugin names for reporting consumers.

#### Returns

`Promise`\<[`PluginReport`](/reference/api/interfaces/pluginreport/)[]\>

---

### getRuntimeInfo()

> **getRuntimeInfo**(): `Promise`\<[`RuntimeInfoReport`](/reference/api/interfaces/runtimeinforeport/)\>

Defined in: [junior/src/reporting.ts:99](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L99)

Read authenticated runtime discovery data for reporting consumers.

#### Returns

`Promise`\<[`RuntimeInfoReport`](/reference/api/interfaces/runtimeinforeport/)\>

---

### getSessions()

> **getSessions**(): `Promise`\<[`ConversationFeed`](/reference/api/interfaces/conversationfeed/)\>

Defined in: [junior/src/reporting.ts:105](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L105)

Read recent conversation summaries for reporting consumers.

#### Returns

`Promise`\<[`ConversationFeed`](/reference/api/interfaces/conversationfeed/)\>

---

### getSkills()

> **getSkills**(): `Promise`\<[`SkillReport`](/reference/api/interfaces/skillreport/)[]\>

Defined in: [junior/src/reporting.ts:103](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L103)

Read discovered skill names for reporting consumers.

#### Returns

`Promise`\<[`SkillReport`](/reference/api/interfaces/skillreport/)[]\>

---

### listRecentConversations()?

> `optional` **listRecentConversations**(`options?`): `Promise`\<[`PluginConversationSummary`](/reference/api/interfaces/pluginconversationsummary/)[]\>

Defined in: [junior/src/reporting.ts:109](https://github.com/getsentry/junior/blob/main/packages/junior/src/reporting.ts#L109)

Read recent conversation summaries without transcript payloads.

#### Parameters

##### options?

###### limit?

`number`

#### Returns

`Promise`\<[`PluginConversationSummary`](/reference/api/interfaces/pluginconversationsummary/)[]\>
