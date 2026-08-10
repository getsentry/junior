# Changelog
## 0.146.0

### New Features ✨

- (conversations) Expand and align retained conversation tools by @sentry-junior in [#1355](https://github.com/getsentry/junior/pull/1355)
- (slack) Resolve identity-backed mentions by @sentry-junior in [#1358](https://github.com/getsentry/junior/pull/1358)

### Bug Fixes 🐛

#### Slack

- Render blocks in secondary attachments by @erickreutz in [#1346](https://github.com/getsentry/junior/pull/1346)
- Return mention format from user lookup by @sentry-junior in [#1352](https://github.com/getsentry/junior/pull/1352)

#### Other

- (tools) Rank catalog searches by relevance by @dcramer in [#1351](https://github.com/getsentry/junior/pull/1351)

### Documentation 📚

#### Policy

- Add agent-steering anti prompt-bloat rules by @sentry-junior in [#1354](https://github.com/getsentry/junior/pull/1354)
- Tighten frontend component taste rules by @sentry-junior in [#1353](https://github.com/getsentry/junior/pull/1353)

#### Other

- (policies) Rewrite policies in plain English by @sentry-junior in [#1350](https://github.com/getsentry/junior/pull/1350)

### Internal Changes 🔧

- (chat) Drop dead turn-cursor model metadata by @sentry-junior in [#1356](https://github.com/getsentry/junior/pull/1356)

## 0.145.0

### New Features ✨

- (dashboard) Compact task conversation header by @sentry-junior in [#1347](https://github.com/getsentry/junior/pull/1347)

### Documentation 📚

- (github) Improve PR description guidance by @sentry-junior in [#1345](https://github.com/getsentry/junior/pull/1345)

### Internal Changes 🔧

- (chat) Simplify durable conversation execution by @sentry-junior in [#1344](https://github.com/getsentry/junior/pull/1344)
- (evals) Run suites only on eval changes or labels by @sentry-junior in [#1348](https://github.com/getsentry/junior/pull/1348)

## 0.144.0

### New Features ✨

#### Dashboard

- Add task navigation with shared filters by @sentry-junior in [#1339](https://github.com/getsentry/junior/pull/1339)
- Add opt-in average line to activity charts by @sentry-junior in [#1338](https://github.com/getsentry/junior/pull/1338)
- Link task-triggered conversations back to their task by @sentry-junior in [#1306](https://github.com/getsentry/junior/pull/1306)
- Show daily profile usage in activity tooltips by @sentry-junior in [#1340](https://github.com/getsentry/junior/pull/1340)

#### Other

- (scheduler) Move scheduled tasks via list and update by @sentry-junior in [#1336](https://github.com/getsentry/junior/pull/1336)

### Bug Fixes 🐛

- (github) Treat sandbox clone as ordinary read work by @sentry-junior in [#1333](https://github.com/getsentry/junior/pull/1333)
- (scheduler) Point management errors at current destination by @sentry-junior in [#1341](https://github.com/getsentry/junior/pull/1341)

### Internal Changes 🔧

- (dashboard) Share secondary navigation by @sentry-junior in [#1337](https://github.com/getsentry/junior/pull/1337)
- (deps) Bump react-router from 7.16.0 to 7.18.2 by @dependabot in [#1295](https://github.com/getsentry/junior/pull/1295)

## 0.143.0

### Bug Fixes 🐛

#### Dashboard

- Share chart header and axis label components by @sentry-junior in [#1329](https://github.com/getsentry/junior/pull/1329)
- Share page-level time range selectors by @sentry-junior in [#1330](https://github.com/getsentry/junior/pull/1330)

### Internal Changes 🔧

#### Dashboard

- Extract shared drawer components by @sentry-junior in [#1334](https://github.com/getsentry/junior/pull/1334)
- Enable oxlint React hooks rules by @sentry-junior in [#1332](https://github.com/getsentry/junior/pull/1332)

#### Other

- (evals) Prefer natural user-led prompts by @sentry-junior in [#1327](https://github.com/getsentry/junior/pull/1327)

## 0.142.0

### New Features ✨

- (tasks) Generate and display short task titles by @sentry-junior in [#1318](https://github.com/getsentry/junior/pull/1318)

### Bug Fixes 🐛

- (dashboard) Render Guardian review bars by @sentry-junior in [#1325](https://github.com/getsentry/junior/pull/1325)
- (scheduler) Require action review for delete and run-now by @sentry-junior in [#1324](https://github.com/getsentry/junior/pull/1324)
- (slack) Route silent acknowledgements through reactions by @sentry-junior in [#1322](https://github.com/getsentry/junior/pull/1322)

### Internal Changes 🔧

- (chat) Remove unused conversation working stats by @sentry-junior in [#1323](https://github.com/getsentry/junior/pull/1323)
- (evals) Align scheduled post intent with Guardian by @sentry-junior in [#1326](https://github.com/getsentry/junior/pull/1326)

## 0.141.0

### New Features ✨

- (chat) Surface AGENTS.md in conversation transcripts by @sentry-junior in [#1321](https://github.com/getsentry/junior/pull/1321)

### Bug Fixes 🐛

- (dashboard) Add shared tooltips to memory charts by @sentry-junior in [#1317](https://github.com/getsentry/junior/pull/1317)

### Internal Changes 🔧

#### Chat

- Write thread/channel scratch with Junior TTL by @sentry-junior in [#1320](https://github.com/getsentry/junior/pull/1320)
- Remove turn-session ops metadata from Redis by @sentry-junior in [#1315](https://github.com/getsentry/junior/pull/1315)

#### Other

- (evals) Split suites into independent workflows by @sentry-junior in [#1319](https://github.com/getsentry/junior/pull/1319)

## 0.140.0

### New Features ✨

- (scheduler) Include dashboard task links in schedule tool results by @sentry-junior in [#1305](https://github.com/getsentry/junior/pull/1305)

### Bug Fixes 🐛

#### Scheduler

- Keep completed one-off tasks visible to creators by @sentry-junior in [#1304](https://github.com/getsentry/junior/pull/1304)
- Emit scheduled-task lifecycle telemetry by @sentry-junior in [#1303](https://github.com/getsentry/junior/pull/1303)

### Internal Changes 🔧

#### Chat

- Thin turn-session recovery indexes by @sentry-junior in [#1313](https://github.com/getsentry/junior/pull/1313)
- Shorten turn session retention by @sentry-junior in [#1308](https://github.com/getsentry/junior/pull/1308)

#### Evals

- Remove direct memory adjudication case by @sentry-junior in [#1314](https://github.com/getsentry/junior/pull/1314)
- Move wave-2 event-task and scheduler contracts by @sentry-junior in [#1312](https://github.com/getsentry/junior/pull/1312)
- Bump vitest-evals and use Check Run score by @sentry-junior in [#1307](https://github.com/getsentry/junior/pull/1307)
- Trigger suites independently by @sentry-junior in [#1311](https://github.com/getsentry/junior/pull/1311)
- Move wave-1 system contracts into integration by @sentry-junior in [#1309](https://github.com/getsentry/junior/pull/1309)
- Use native pass-rate gating under Evals jobs by @sentry-junior in [#1294](https://github.com/getsentry/junior/pull/1294)

## 0.139.0

### New Features ✨

- (tasks) Browse terminal task executions from the dashboard by @sentry-junior in [#1299](https://github.com/getsentry/junior/pull/1299)
- (telemetry) Include Junior version in deployment release by @sentry-junior in [#1302](https://github.com/getsentry/junior/pull/1302)

### Bug Fixes 🐛

#### Dashboard

- Add compact badge and chart type step by @sentry-junior in [#1296](https://github.com/getsentry/junior/pull/1296)
- Label the active model in metric tooltips by @sentry-junior in [#1297](https://github.com/getsentry/junior/pull/1297)

#### Other

- (transcript) Preserve readable markdown structure by @sentry-junior in [#1300](https://github.com/getsentry/junior/pull/1300)

### Internal Changes 🔧

#### Evals

- Split integration and behavioral suites by @sentry-junior in [#1301](https://github.com/getsentry/junior/pull/1301)
- Add isolated Guardian decision suite by @sentry-junior in [#1293](https://github.com/getsentry/junior/pull/1293)

#### Other

- (chat) Stop writing actor into turn-session Redis by @sentry-junior in [#1298](https://github.com/getsentry/junior/pull/1298)

## 0.138.0

### New Features ✨

- (agent) Add durable agent invocations and spawning by @dcramer in [#1065](https://github.com/getsentry/junior/pull/1065)

### Bug Fixes 🐛

- (chat) Bound conversation work retries by @sentry-junior in [#1287](https://github.com/getsentry/junior/pull/1287)
- (dashboard) Simplify task table layout by @sentry-junior in [#1291](https://github.com/getsentry/junior/pull/1291)
- (evals) Build real Chat SDK messages in the harness by @sentry-junior in [#1292](https://github.com/getsentry/junior/pull/1292)

### Internal Changes 🔧

- (chat) Project turn sessions through explicit schemas by @sentry-junior in [#1286](https://github.com/getsentry/junior/pull/1286)
- (dashboard) Remove flavor headers by @sentry-junior in [#1290](https://github.com/getsentry/junior/pull/1290)
- (evals) Gate the suite on aggregate pass rate by @sentry-junior in [#1289](https://github.com/getsentry/junior/pull/1289)

## 0.137.0

### New Features ✨

#### Dashboard

- Show conversation activity on system overview by @sentry-junior in [#1282](https://github.com/getsentry/junior/pull/1282)
- Make detail rows selectable by @sentry-junior in [#1271](https://github.com/getsentry/junior/pull/1271)

#### Other

- (github) Allow workflow run control by @sentry-junior in [#1269](https://github.com/getsentry/junior/pull/1269)
- (slack) Build thread archive source urls from team.info by @sentry-junior in [#1283](https://github.com/getsentry/junior/pull/1283)

### Bug Fixes 🐛

#### Dashboard

- Enforce a readable type scale floor by @sentry-junior in [#1284](https://github.com/getsentry/junior/pull/1284)
- Show live conversation metrics by @sentry-junior in [#1280](https://github.com/getsentry/junior/pull/1280)

#### Slack

- Trust canonical formatted message text by @sentry-junior in [#1270](https://github.com/getsentry/junior/pull/1270)
- Align passive reply router with Guardian by @sentry-junior in [#1281](https://github.com/getsentry/junior/pull/1281)

#### Other

- (ai-gateway) Prefer Vercel OIDC for project attribution by @sentry-junior in [#1275](https://github.com/getsentry/junior/pull/1275)
- (ci) Unblock mainline typecheck, lint, and integration failures by @sentry-junior in [#1285](https://github.com/getsentry/junior/pull/1285)
- (config) Warn on unregistered config defaults by @dcramer in [#1265](https://github.com/getsentry/junior/pull/1265)
- (sandbox) Start dockerd for nested Docker Compose by @sentry-junior in [#1274](https://github.com/getsentry/junior/pull/1274)

### Documentation 📚

- (concepts) Rewrite product model docs by @sentry-junior in [#1277](https://github.com/getsentry/junior/pull/1277)
- (plugins) Standardize config reference sections by @sentry-junior in [#1278](https://github.com/getsentry/junior/pull/1278)
- (reference) Keep plugin env off config page by @sentry-junior in [#1276](https://github.com/getsentry/junior/pull/1276)
- (sentry) Use plugin constructor in setup guidance by @sentry-junior in [#1273](https://github.com/getsentry/junior/pull/1273)

### Internal Changes 🔧

- (chat) Load turn-session routing from SQL on resume by @sentry-junior in [#1268](https://github.com/getsentry/junior/pull/1268)

### Other

- .github/workflows: Migrate workflows to Blacksmith runners by @blacksmith-sh in [#1272](https://github.com/getsentry/junior/pull/1272)

## 0.136.1

### Bug Fixes 🐛

- (memory) Accept canonical system actors by @dcramer in [#1264](https://github.com/getsentry/junior/pull/1264)

## 0.136.0

### New Features ✨

- (dashboard) Add shareable task and memory views by @sentry-junior in [#1262](https://github.com/getsentry/junior/pull/1262)
- (github) Expose pull_request.opened and ready_for_review events by @sentry-junior in [#1259](https://github.com/getsentry/junior/pull/1259)
- (sentry) Add issue resource events by @sentry-junior in [#1260](https://github.com/getsentry/junior/pull/1260)
- (vercel) Add project-scoped deployment subscriptions by @sentry-junior in [#1263](https://github.com/getsentry/junior/pull/1263)

### Documentation 📚

- (plugins) Document resource subscriptions by @sentry-junior in [#1261](https://github.com/getsentry/junior/pull/1261)

## 0.135.0

### Bug Fixes 🐛

#### Dashboard

- Open memory details in a slide-out drawer by @sentry-junior in [#1256](https://github.com/getsentry/junior/pull/1256)
- Polish tasks page and open details in a slide-out by @sentry-junior in [#1254](https://github.com/getsentry/junior/pull/1254)

#### Other

- (memory) Keep personal prefs in automatic recall by @sentry-junior in [#1255](https://github.com/getsentry/junior/pull/1255)
- (tasks) Remove plugin background work from tasks by @sentry-junior in [#1253](https://github.com/getsentry/junior/pull/1253)

## 0.134.0

### New Features ✨

- (chat) Load repository AGENTS.md context by @dcramer in [#1229](https://github.com/getsentry/junior/pull/1229)
- (dashboard) Show per-task execution analytics by @sentry-junior in [#1220](https://github.com/getsentry/junior/pull/1220)
- (memory) Add recall and extraction flags by @sentry-junior in [#1245](https://github.com/getsentry/junior/pull/1245)

### Bug Fixes 🐛

- (github) Post PR reviews and inline comments as the App bot by @sentry-junior in [#1252](https://github.com/getsentry/junior/pull/1252)
- (slack) Make user lookup reliable across models by @Elih96 in [#1251](https://github.com/getsentry/junior/pull/1251)

### Internal Changes 🔧

- (memory) Harden hybrid automatic recall by @sentry-junior in [#1250](https://github.com/getsentry/junior/pull/1250)

## 0.133.0

### New Features ✨

- (dashboard) Make result lists easier to scan by @dcramer in [#1240](https://github.com/getsentry/junior/pull/1240)
- (sql) Configure statement timeout by @dcramer in [#1236](https://github.com/getsentry/junior/pull/1236)

### Bug Fixes 🐛

#### Slack

- Bind dispatched conversations to threads by @sentry-junior in [#1232](https://github.com/getsentry/junior/pull/1232)
- Recognize interrupts after mentions by @sentry-junior in [#1239](https://github.com/getsentry/junior/pull/1239)

### Internal Changes 🔧

- (memory) Bound lexical ranking candidates by @dcramer in [#1242](https://github.com/getsentry/junior/pull/1242)
- (sql) Cap runtime statements at 30 seconds by @dcramer in [#1235](https://github.com/getsentry/junior/pull/1235)

## 0.132.0

### New Features ✨

- (dashboard) Simplify system navigation by @dcramer in [#1231](https://github.com/getsentry/junior/pull/1231)
- (sentry) Expand OAuth scopes by @sentry-junior in [#1230](https://github.com/getsentry/junior/pull/1230)

### Bug Fixes 🐛

- (scheduler) Drop paused scheduled-task status by @sentry-junior in [#1226](https://github.com/getsentry/junior/pull/1226)

### Internal Changes 🔧

- (conversations) Introduce provider location read model by @dcramer in [#1205](https://github.com/getsentry/junior/pull/1205)
- (memory) Optimize lexical search by @dcramer in [#1233](https://github.com/getsentry/junior/pull/1233)

## 0.131.0

### New Features ✨

- (sandbox) Add Docker Compose to baseline by @sentry-junior in [#1225](https://github.com/getsentry/junior/pull/1225)

### Bug Fixes 🐛

- (event-tasks) Add reply attribution footer for event dispatches by @sentry-junior in [#1223](https://github.com/getsentry/junior/pull/1223)
- (slack) Disable message unfurls by @sentry-junior in [#1222](https://github.com/getsentry/junior/pull/1222)

### Internal Changes 🔧

- (memory) Remove structured identifier matching by @dcramer in [#1227](https://github.com/getsentry/junior/pull/1227)

## 0.130.0

### New Features ✨

- (github) Add release resource watches by @sentry-junior in [#1219](https://github.com/getsentry/junior/pull/1219)

### Bug Fixes 🐛

- (github) Deliver repository-scoped PR events by @sentry-junior in [#1216](https://github.com/getsentry/junior/pull/1216)

## 0.129.0

### Breaking Changes 🛠

- (core) Move Scheduler into core by @dcramer in [#1212](https://github.com/getsentry/junior/pull/1212)

### New Features ✨

- (dashboard) Group conversations by activity by @dcramer in [#1213](https://github.com/getsentry/junior/pull/1213)
- (sandbox) Configure vCPUs from app options by @sentry-junior in [#1215](https://github.com/getsentry/junior/pull/1215)

### Documentation 📚

- (homepage) Showcase integrations by @dcramer in [#1211](https://github.com/getsentry/junior/pull/1211)

## 0.128.0

### Breaking Changes 🛠

- (plugins) Use canonical users for personal ownership by @dcramer in [#1196](https://github.com/getsentry/junior/pull/1196)
- (tools) Use canonical tool outputs by @dcramer in [#1207](https://github.com/getsentry/junior/pull/1207)

### New Features ✨

- (core) Run tasks from resource events by @dcramer in [#1176](https://github.com/getsentry/junior/pull/1176)

### Bug Fixes 🐛

#### Dashboard

- Preserve expanded transcript events by @dcramer in [#1204](https://github.com/getsentry/junior/pull/1204)
- Distinguish memory events from reasoning by @dcramer in [#1202](https://github.com/getsentry/junior/pull/1202)

#### Other

- (agent) Keep MCP provider failures out of action review by @dcramer in [#1209](https://github.com/getsentry/junior/pull/1209)
- (core) Scope resource events to Slack workspace by @dcramer in [#1201](https://github.com/getsentry/junior/pull/1201)

### Documentation 📚

- Drop stale ABOUT.md and plugin migration notes by @sentry-junior in [#1198](https://github.com/getsentry/junior/pull/1198)

### Internal Changes 🔧

#### Dashboard

- Animate active indicators by @dcramer in [#1203](https://github.com/getsentry/junior/pull/1203)
- Increase small text size by @dcramer in [#1199](https://github.com/getsentry/junior/pull/1199)

#### Other

- (docs) Soften homepage color scheme by @dcramer in [#1208](https://github.com/getsentry/junior/pull/1208)

## 0.127.0

### New Features ✨

- (core) Catalog plugin resource events by @dcramer in [#1191](https://github.com/getsentry/junior/pull/1191)
- (dashboard) Add personal spend to profile menu by @dcramer in [#1195](https://github.com/getsentry/junior/pull/1195)

### Bug Fixes 🐛

- (dashboard) Support selectable tooltips across inputs by @dcramer in [#1189](https://github.com/getsentry/junior/pull/1189)
- (github) Bracket the secondary Sentry link by @sentry-junior in [#1193](https://github.com/getsentry/junior/pull/1193)
- (scheduler) Backfill legacy conversation access by @dcramer in [#1192](https://github.com/getsentry/junior/pull/1192)

### Internal Changes 🔧

- (dashboard) Group stats under System by @dcramer in [#1194](https://github.com/getsentry/junior/pull/1194)

## 0.126.1

### Bug Fixes 🐛

- (dashboard) Correct metric tooltip layout by @dcramer in [#1190](https://github.com/getsentry/junior/pull/1190)

## 0.126.0

### Breaking Changes 🛠

- (plugin-api) Standardize source visibility by @dcramer in [#1183](https://github.com/getsentry/junior/pull/1183)

### New Features ✨

- (dashboard) Improve cost breakdowns by @dcramer in [#1181](https://github.com/getsentry/junior/pull/1181)
- (scheduler) Label scheduled task replies by @dcramer in [#1187](https://github.com/getsentry/junior/pull/1187)

### Bug Fixes 🐛

- (dashboard) Reuse cached API reads by @dcramer in [#1180](https://github.com/getsentry/junior/pull/1180)
- (prompt) Keep skill routing in skill policy by @sentry-junior in [#1179](https://github.com/getsentry/junior/pull/1179)
- (scheduler) Preserve public dispatch visibility by @dcramer in [#1182](https://github.com/getsentry/junior/pull/1182)

## 0.125.0

### New Features ✨

#### Conversations

- Show auxiliary cost breakdown by @dcramer in [#1178](https://github.com/getsentry/junior/pull/1178)
- Persist structured session source by @sentry-junior in [#1172](https://github.com/getsentry/junior/pull/1172)

#### Memory

- Track automatic recall cost by @dcramer in [#1177](https://github.com/getsentry/junior/pull/1177)
- Chart passive extraction cost by @dcramer in [#1175](https://github.com/getsentry/junior/pull/1175)
- Track passive extraction cost by @dcramer in [#1173](https://github.com/getsentry/junior/pull/1173)

#### Other

- (dashboard) Add all plugins system view by @dcramer in [#1171](https://github.com/getsentry/junior/pull/1171)
- (scheduler) Default to creator credentials by @dcramer in [#1169](https://github.com/getsentry/junior/pull/1169)

## 0.124.2

### New Features ✨

- (memory) Surface public memories in dashboard by @sentry-junior in [#1168](https://github.com/getsentry/junior/pull/1168)

## 0.124.1

### New Features ✨

- (github) Show dashboard and Sentry session links by @sentry-junior in [#1165](https://github.com/getsentry/junior/pull/1165)
- Improve memory management across user pages and dashboard by @dcramer in [#1159](https://github.com/getsentry/junior/pull/1159)

### Bug Fixes 🐛

- (dashboard) Slim mobile conversation chrome by @sentry-junior in [#1166](https://github.com/getsentry/junior/pull/1166)

## 0.124.0

### New Features ✨

- (conversations) Add authentication structured events by @sentry-junior in [#1161](https://github.com/getsentry/junior/pull/1161)

### Bug Fixes 🐛

- (agent) Harden Guardian structured review by @dcramer in [#1164](https://github.com/getsentry/junior/pull/1164)

### Documentation 📚

- (skills) Keep ticket handoffs diagnosis-first by @sentry-junior in [#1152](https://github.com/getsentry/junior/pull/1152)

### Internal Changes 🔧

- (dashboard) Organize component ownership by @dcramer in [#1160](https://github.com/getsentry/junior/pull/1160)

## 0.123.0

### New Features ✨

#### Dashboard

- Add Guardian stats to System by @dcramer in [#1155](https://github.com/getsentry/junior/pull/1155)
- Animate archived conversations by @dcramer in [#1145](https://github.com/getsentry/junior/pull/1145)

#### Other

- (agent) Enforce Guardian action review by @dcramer in [#1082](https://github.com/getsentry/junior/pull/1082)
- (plugins) Add structured conversation events by @dcramer in [#1154](https://github.com/getsentry/junior/pull/1154)
- (slack) Force unsubscribe with !stop by @sentry-junior in [#1144](https://github.com/getsentry/junior/pull/1144)

### Bug Fixes 🐛

#### Dashboard

- Add conversations navigation link by @dcramer in [#1158](https://github.com/getsentry/junior/pull/1158)
- Remove conversation list from location details by @dcramer in [#1157](https://github.com/getsentry/junior/pull/1157)
- Attribute transcript messages to Slack actors by @dcramer in [#1151](https://github.com/getsentry/junior/pull/1151)
- Render user prose as markdown by @dcramer in [#1153](https://github.com/getsentry/junior/pull/1153)
- Show ellipsis for long conversation titles by @dcramer in [#1150](https://github.com/getsentry/junior/pull/1150)

#### Other

- (agent) Require tool behavior annotations by @dcramer in [#1156](https://github.com/getsentry/junior/pull/1156)
- (github) Drop redundant "via Junior" from requester attribution by @sentry-junior in [#1147](https://github.com/getsentry/junior/pull/1147)

### Internal Changes 🔧

#### Deps

- Bump astro from 6.3.7 to 7.1.1 by @dependabot in [#1063](https://github.com/getsentry/junior/pull/1063)
- Bump hono from 4.12.22 to 4.12.27 by @dependabot in [#1061](https://github.com/getsentry/junior/pull/1061)
- Bump better-auth from 1.6.11 to 1.6.22 by @dependabot in [#1048](https://github.com/getsentry/junior/pull/1048)

#### Other

- (deps-dev) Bump undici from 7.28.0 to 7.29.0 in /packages/junior-evals by @dependabot in [#1047](https://github.com/getsentry/junior/pull/1047)
- (tools) Make deferred tool schemas authoritative by @sentry-junior in [#1140](https://github.com/getsentry/junior/pull/1140)

### Other

- Remove broken GitHub asset skill by @dcramer in [#1143](https://github.com/getsentry/junior/pull/1143)

## 0.122.1

### Bug Fixes 🐛

- (linear) Annotate save_issue creates via afterMcpTool by @sentry-junior in [#1142](https://github.com/getsentry/junior/pull/1142)

## 0.122.0

### New Features ✨

- (scheduler) Add personal scheduled tasks page by @dcramer in [#1135](https://github.com/getsentry/junior/pull/1135)

### Bug Fixes 🐛

#### Chat

- Correct compaction and empty output continuation by @dcramer in [#1137](https://github.com/getsentry/junior/pull/1137)
- Order agent history before visible replies by @dcramer in [#1128](https://github.com/getsentry/junior/pull/1128)

#### Other

- (linear) Wrap save_issue mutations by @dcramer in [#1136](https://github.com/getsentry/junior/pull/1136)
- (slack) Continue after image analysis failures by @dcramer in [#1139](https://github.com/getsentry/junior/pull/1139)
- (tools) Bound conversation event query responses by @dcramer in [#1134](https://github.com/getsentry/junior/pull/1134)

### Internal Changes 🔧

- (logging) Simplify structured event emission by @dcramer in [#1138](https://github.com/getsentry/junior/pull/1138)
- Enforce higher-fidelity test boundaries by @dcramer in [#1132](https://github.com/getsentry/junior/pull/1132)

## 0.121.0

### New Features ✨

- (github) Watch deployments by commit by @dcramer in [#1129](https://github.com/getsentry/junior/pull/1129)
- (memory) Add system diagnostics by @dcramer in [#1131](https://github.com/getsentry/junior/pull/1131)

### Bug Fixes 🐛

- (evals) Stabilize agent behavior suites by @dcramer in [#1112](https://github.com/getsentry/junior/pull/1112)
- (memory) Persist personal recall context by @dcramer in [#1130](https://github.com/getsentry/junior/pull/1130)

## 0.120.0

### New Features ✨

- (linear) Add native issue creation tool by @dcramer in [#1119](https://github.com/getsentry/junior/pull/1119)
- (memory) Add personal memory REST management by @dcramer in [#1126](https://github.com/getsentry/junior/pull/1126)

### Bug Fixes 🐛

- (memory) Improve recall relevance by @dcramer in [#1127](https://github.com/getsentry/junior/pull/1127)

### Internal Changes 🔧

- (dashboard) Compact annotation links by @dcramer in [#1125](https://github.com/getsentry/junior/pull/1125)

## 0.119.0

### Breaking Changes 🛠

- (plugins) Standardize plugin factory names by @dcramer in [#1122](https://github.com/getsentry/junior/pull/1122)

### New Features ✨

- (reporting) Expose assistant reasoning events by @dcramer in [#1104](https://github.com/getsentry/junior/pull/1104)
- (telemetry) Add GenAI message size attributes by @sentry-junior in [#1123](https://github.com/getsentry/junior/pull/1123)

### Bug Fixes 🐛

- (compaction) Require evidence before marking tasks complete by @sentry-junior in [#1121](https://github.com/getsentry/junior/pull/1121)
- (prompt) Keep Slack replies brief by @sentry-junior in [#1124](https://github.com/getsentry/junior/pull/1124)
- (slack) Normalize Canvas markdown by @dcramer in [#1115](https://github.com/getsentry/junior/pull/1115)

## 0.118.0

### New Features ✨

#### Github

- Link issues to conversations by @dcramer in [#1102](https://github.com/getsentry/junior/pull/1102)
- Subscribe to deployment events by @dcramer in [#1094](https://github.com/getsentry/junior/pull/1094)

#### Other

- (docs) Redesign Junior homepage by @dcramer in [#1106](https://github.com/getsentry/junior/pull/1106)
- (plugins) Add core-rendered user pages by @dcramer in [#1113](https://github.com/getsentry/junior/pull/1113)
- (reporting) Record daily skill usage by @dcramer in [#1101](https://github.com/getsentry/junior/pull/1101)

### Bug Fixes 🐛

#### Dashboard

- Forward token and stats routes by @dcramer in [#1116](https://github.com/getsentry/junior/pull/1116)
- Tidy system plugin reporting views by @dcramer in [#1100](https://github.com/getsentry/junior/pull/1100)
- Stringify tool argument strings by @dcramer in [#1105](https://github.com/getsentry/junior/pull/1105)

#### Other

- (skills) Load dollar-prefixed skill references by @dcramer in [#1099](https://github.com/getsentry/junior/pull/1099)

### Documentation 📚

- Use Junior mascot across homepage branding by @dcramer in [#1111](https://github.com/getsentry/junior/pull/1111)

### Internal Changes 🔧

#### Sandbox

- Bound ripgrep searches by @dcramer in [#1117](https://github.com/getsentry/junior/pull/1117)
- Reduce and measure search overhead by @dcramer in [#1110](https://github.com/getsentry/junior/pull/1110)

#### Other

- Remove a bunch of bundled skills by @dcramer in [#1120](https://github.com/getsentry/junior/pull/1120)

### Other

- Widen locations runtime column by @dcramer in [#1118](https://github.com/getsentry/junior/pull/1118)
- Standardize dashboard neutral text colors by @dcramer in [#1107](https://github.com/getsentry/junior/pull/1107)

## 0.117.0

### New Features ✨

- (agent) Add workspace image inspection by @dcramer in [#1098](https://github.com/getsentry/junior/pull/1098)
- (plugins) Add structured turn context by @dcramer in [#1089](https://github.com/getsentry/junior/pull/1089)

### Bug Fixes 🐛

- (chat) Continue active turns after compaction by @dcramer in [#1095](https://github.com/getsentry/junior/pull/1095)
- (oauth) Harden provider errors and callbacks by @jstar0 in [#1079](https://github.com/getsentry/junior/pull/1079)
- (sandbox) Install ripgrep through SPAL by @dcramer in [#1092](https://github.com/getsentry/junior/pull/1092)
- Make agent name configurable by @sentry-junior in [#1096](https://github.com/getsentry/junior/pull/1096)

### Internal Changes 🔧

- (deps-dev) Bump undici from 7.25.0 to 7.28.0 by @dependabot in [#1084](https://github.com/getsentry/junior/pull/1084)
- (sandbox) Simplify snapshot dependency resolution by @dcramer in [#1097](https://github.com/getsentry/junior/pull/1097)

## 0.116.1

### Bug Fixes 🐛

- (sandbox) Install ripgrep from pinned release by @dcramer in [#1090](https://github.com/getsentry/junior/pull/1090)

## 0.116.0

### Breaking Changes 🛠

- (chat) Store native agent history events by @dcramer in [#1087](https://github.com/getsentry/junior/pull/1087)

### New Features ✨

#### Tools

- Back sandbox search with ripgrep by @dcramer in [#1086](https://github.com/getsentry/junior/pull/1086)
- Add deferred queryConversationEvents tool by @sentry-junior in [#1072](https://github.com/getsentry/junior/pull/1072)
- Describe approval proposals by @dcramer in [#1064](https://github.com/getsentry/junior/pull/1064)

#### Other

- (api) Add personal access tokens by @sentry-junior in [#1080](https://github.com/getsentry/junior/pull/1080)
- (github) Show conversation pull requests by @sentry-junior in [#1081](https://github.com/getsentry/junior/pull/1081)

### Bug Fixes 🐛

#### Sandbox

- Cancel file tools with agent turn by @dcramer in [#1067](https://github.com/getsentry/junior/pull/1067)
- Keep sandbox alive during long commands by @sentry-junior in [#1071](https://github.com/getsentry/junior/pull/1071)

#### Other

- (context) Preserve active instruction during compaction by @sentry-junior in [#1077](https://github.com/getsentry/junior/pull/1077)
- (dashboard) Clarify tool call metadata by @sentry-junior in [#1070](https://github.com/getsentry/junior/pull/1070)
- (tools) Bound readFile output by @dcramer in [#1085](https://github.com/getsentry/junior/pull/1085)

### Internal Changes 🔧

- (dispatch) Route dispatches through conversation work by @dcramer in [#1059](https://github.com/getsentry/junior/pull/1059)
- (plugins) Remove declared capabilities by @sentry-junior in [#1083](https://github.com/getsentry/junior/pull/1083)

## 0.115.0

### Breaking Changes 🛠

- (dashboard) Add dedicated System plugin pages by @dcramer in [#1058](https://github.com/getsentry/junior/pull/1058)

### New Features ✨

- (dashboard) Show continuation summaries by @dcramer in [#1056](https://github.com/getsentry/junior/pull/1056)
- (slack) Isolate cross-actor follow-up turns by @dcramer in [#1057](https://github.com/getsentry/junior/pull/1057)
- (tools) Declare approval modes by @dcramer in [#1055](https://github.com/getsentry/junior/pull/1055)

### Bug Fixes 🐛

- (cli) Continue local chat after account sign-in by @dcramer in [#1054](https://github.com/getsentry/junior/pull/1054)
- (github) Show median PR cost in ops repo grid by @sentry-junior in [#1049](https://github.com/getsentry/junior/pull/1049)

### Internal Changes 🔧

- Cap code files at 1,000 lines by @dcramer in [#1060](https://github.com/getsentry/junior/pull/1060)

## 0.114.0

### New Features ✨

- (dashboard) Improve collapsed tool call rendering by @dcramer in [#1046](https://github.com/getsentry/junior/pull/1046)

### Bug Fixes 🐛

- (agent) Enforce context window compaction by @dcramer in [#1045](https://github.com/getsentry/junior/pull/1045)
- (ai) Handle invalid structured responses by @dcramer in [#1043](https://github.com/getsentry/junior/pull/1043)
- (conversations) Preserve transcript formatting by @dcramer in [#1044](https://github.com/getsentry/junior/pull/1044)
- (runtime) Separate turn routes from handoffs by @sentry-junior in [#1037](https://github.com/getsentry/junior/pull/1037)

## 0.113.0

### New Features ✨

- (github) Track PR and issue conversation costs by @sentry-junior in [#1040](https://github.com/getsentry/junior/pull/1040)

### Bug Fixes 🐛

- (agent) Prevent duplicate replies after cooperative yield by @dcramer in [#1042](https://github.com/getsentry/junior/pull/1042)
- (provider) Normalize terminal failures by @sentry-junior in [#907](https://github.com/getsentry/junior/pull/907)

### Internal Changes 🔧

- (dashboard) Paginate conversation transcripts by @sentry-junior in [#1017](https://github.com/getsentry/junior/pull/1017)
- (evals) Gate runs on eval changes or label by @sentry-junior in [#1039](https://github.com/getsentry/junior/pull/1039)

## 0.112.0

### New Features ✨

- (auth) Include model intent in all authorization requests by @sentry-junior in [#1024](https://github.com/getsentry/junior/pull/1024)
- (dashboard) Add profile metric charts by @sentry-junior in [#1035](https://github.com/getsentry/junior/pull/1035)

### Bug Fixes 🐛

- (agent) Stop resource watches when users ask by @dcramer in [#1032](https://github.com/getsentry/junior/pull/1032)
- (dashboard) Break down cost by model by @sentry-junior in [#1034](https://github.com/getsentry/junior/pull/1034)
- (github) Simplify dashboard activity reporting by @dcramer in [#1033](https://github.com/getsentry/junior/pull/1033)

### Internal Changes 🔧

- (oauth) Complete headless MCP auth fixture by @dcramer in [#847](https://github.com/getsentry/junior/pull/847)

## 0.111.0

### Bug Fixes 🐛

#### Runtime

- Keep deferred messages out of active turns by @sentry-junior in [#1014](https://github.com/getsentry/junior/pull/1014)
- Derive deadlines from Nitro max duration by @sentry-junior in [#1029](https://github.com/getsentry/junior/pull/1029)

#### Other

- (dashboard) Reflect expanded tool call groups by @sentry-junior in [#1028](https://github.com/getsentry/junior/pull/1028)
- (evals) Stabilize model-backed scenarios by @dcramer in [#1022](https://github.com/getsentry/junior/pull/1022)
- (sandbox) Recover safely from unavailable sessions by @dcramer in [#1012](https://github.com/getsentry/junior/pull/1012)

### Internal Changes 🔧

- (github) Cover interrupted push reconciliation by @sentry-junior in [#919](https://github.com/getsentry/junior/pull/919)
- (runtime) Continue paused work in the same worker by @dcramer in [#1023](https://github.com/getsentry/junior/pull/1023)

## 0.110.0

### New Features ✨

- (agent-browser) Add visual web QA skill by @dcramer in [#1020](https://github.com/getsentry/junior/pull/1020)
- (api) Authorize private transcripts for participants by @sentry-junior in [#981](https://github.com/getsentry/junior/pull/981)
- (reporting) Render plugin chart widgets by @sentry-junior in [#1010](https://github.com/getsentry/junior/pull/1010)

### Bug Fixes 🐛

#### Dashboard

- Show model handoff details by @sentry-junior in [#1016](https://github.com/getsentry/junior/pull/1016)
- Simplify plugin inventory by @sentry-junior in [#1018](https://github.com/getsentry/junior/pull/1018)

#### Other

- (auth) Catch authorization pauses inside agent spans by @sentry-junior in [#1015](https://github.com/getsentry/junior/pull/1015)
- (github) Enforce authoritative commit coauthors by @sentry-junior in [#1021](https://github.com/getsentry/junior/pull/1021)

### Documentation 📚

- Clarify repository agent guidance by @dcramer in [#1026](https://github.com/getsentry/junior/pull/1026)

### Internal Changes 🔧

- (queue) Use conversation IDs in callbacks by @dcramer in [#1019](https://github.com/getsentry/junior/pull/1019)

## 0.109.0

### Breaking Changes 🛠

- (upgrade) Use Drizzle migrations exclusively by @dcramer in [#1011](https://github.com/getsentry/junior/pull/1011)
- (vercel) Add deployment webhook subscriptions by @dcramer in [#1008](https://github.com/getsentry/junior/pull/1008)

### New Features ✨

- (dashboard) Render resource events structurally by @sentry-junior in [#1003](https://github.com/getsentry/junior/pull/1003)
- (docs) Add homepage customer logos by @sentry-junior in [#1001](https://github.com/getsentry/junior/pull/1001)
- (telemetry) Report Junior package version by @sentry-junior in [#905](https://github.com/getsentry/junior/pull/905)

### Bug Fixes 🐛

#### Dashboard

- Simplify and align conversation metrics by @sentry-junior in [#1013](https://github.com/getsentry/junior/pull/1013)
- Render transcript markdown hard breaks by @sentry-junior in [#1006](https://github.com/getsentry/junior/pull/1006)
- Render tool results in transcripts by @dcramer in [#999](https://github.com/getsentry/junior/pull/999)

#### Github

- Report work outcomes instead of open counts by @sentry-junior in [#1004](https://github.com/getsentry/junior/pull/1004)
- Use user credentials for asset uploads by @sentry-junior in [#1002](https://github.com/getsentry/junior/pull/1002)

#### Other

- (agent) Trust event summaries and clarify GitHub auth by @dcramer in [#1005](https://github.com/getsentry/junior/pull/1005)
- (mcp) Skip credentialless provider restoration by @dcramer in [#1009](https://github.com/getsentry/junior/pull/1009)
- (slack) Restore conversation footers on assistant replies by @sentry-junior in [#986](https://github.com/getsentry/junior/pull/986)

### Documentation 📚

- (start-here) Restore agent onboarding runbook by @sentry-junior in [#996](https://github.com/getsentry/junior/pull/996)

### Internal Changes 🔧

- (docs) Bump starlight theme to 0.9.1 by @sentry-junior in [#1007](https://github.com/getsentry/junior/pull/1007)
- (logging) Decouple async log context by @sentry-junior in [#970](https://github.com/getsentry/junior/pull/970)
- (runtime) Simplify resumed turn commits by @dcramer in [#995](https://github.com/getsentry/junior/pull/995)

## 0.108.0

### New Features ✨

- (dashboard) Archive conversations from sidebar by @dcramer in [#988](https://github.com/getsentry/junior/pull/988)
- (github) Add issue and PR outcome analytics by @dcramer in [#990](https://github.com/getsentry/junior/pull/990)

### Bug Fixes 🐛

#### Dashboard

- Show plugin reports above capability inventories by @sentry-junior in [#998](https://github.com/getsentry/junior/pull/998)
- Remove conversation status badges by @dcramer in [#997](https://github.com/getsentry/junior/pull/997)

#### Other

- (agent) Continue after execution-slice timeouts by @dcramer in [#977](https://github.com/getsentry/junior/pull/977)
- (conversations) Project compacted history consistently by @dcramer in [#989](https://github.com/getsentry/junior/pull/989)
- (identity) Use canonical user names in conversations by @dcramer in [#983](https://github.com/getsentry/junior/pull/983)
- (runtime) Validate durable state boundaries by @dcramer in [#994](https://github.com/getsentry/junior/pull/994)
- (sandbox) Avoid command log lookup races by @dcramer in [#992](https://github.com/getsentry/junior/pull/992)
- (scheduler) Compute next runs from structured intent by @dcramer in [#984](https://github.com/getsentry/junior/pull/984)
- (self-update) Use GitHub release notes for release context by @sentry-junior in [#985](https://github.com/getsentry/junior/pull/985)
- (slack) Cancel resource watches on thread stop by @dcramer in [#987](https://github.com/getsentry/junior/pull/987)
- (state) Connect adapter lazily before operations by @schibrikov in [#980](https://github.com/getsentry/junior/pull/980)

### Internal Changes 🔧

- (agent) Stabilize wall-clock provider retry timer wait by @sentry-junior in [#991](https://github.com/getsentry/junior/pull/991)
- (docs) Bump starlight theme to 0.8.0 by @sentry-junior in [#1000](https://github.com/getsentry/junior/pull/1000)
- (evals) Cover OAuth connection and refresh flows by @dcramer in [#993](https://github.com/getsentry/junior/pull/993)

## 0.107.1

### Bug Fixes 🐛

- (migrations) Preserve history without compaction summary by @dcramer in [#982](https://github.com/getsentry/junior/pull/982)

## 0.107.0

### Breaking Changes 🛠

- (conversations) Unify durable conversation history by @dcramer in [#916](https://github.com/getsentry/junior/pull/916)

### New Features ✨

#### Dashboard

- Break down token usage by model by @sentry-junior in [#962](https://github.com/getsentry/junior/pull/962)
- Show typing indicator for active turns by @sentry-junior in [#961](https://github.com/getsentry/junior/pull/961)

#### Github

- Track Junior pull request outcomes by @dcramer in [#976](https://github.com/getsentry/junior/pull/976)
- Add pull request update tool by @sentry-junior in [#963](https://github.com/getsentry/junior/pull/963)

#### Other

- (agent) Deliver completed assistant messages by @dcramer in [#969](https://github.com/getsentry/junior/pull/969)

### Bug Fixes 🐛

#### Agent

- Force handoff profile to high reasoning by @dcramer in [#978](https://github.com/getsentry/junior/pull/978)
- Route complex turns through execution profiles by @dcramer in [#974](https://github.com/getsentry/junior/pull/974)
- Hide tool-call narration from replies by @dcramer in [#972](https://github.com/getsentry/junior/pull/972)
- Preserve generated artifact paths by @dcramer in [#971](https://github.com/getsentry/junior/pull/971)
- Align model defaults and eval contracts by @dcramer in [#964](https://github.com/getsentry/junior/pull/964)

#### Other

- (memory) Reuse semantic preference duplicates by @dcramer in [#973](https://github.com/getsentry/junior/pull/973)
- (slack) Resume turns after transient reply failures by @dcramer in [#975](https://github.com/getsentry/junior/pull/975)

### Internal Changes 🔧

#### Evals

- Organize and shard end-to-end suites by @sentry-junior in [#968](https://github.com/getsentry/junior/pull/968)
- Accept explicit Slack URL links by @dcramer in [#967](https://github.com/getsentry/junior/pull/967)
- Add isolated global sandbox egress by @dcramer in [#943](https://github.com/getsentry/junior/pull/943)

