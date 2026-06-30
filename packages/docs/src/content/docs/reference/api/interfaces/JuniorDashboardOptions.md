---
editUrl: false
next: false
prev: false
title: "JuniorDashboardOptions"
---

Defined in: [junior/src/app.ts:101](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L101)

## Properties

### allowedEmails?

> `optional` **allowedEmails?**: `string`[]

Defined in: [junior/src/app.ts:107](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L107)

Exact Google account emails allowed to open the dashboard.

---

### allowedGoogleDomains?

> `optional` **allowedGoogleDomains?**: `string`[]

Defined in: [junior/src/app.ts:109](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L109)

Google Workspace domains allowed to open the dashboard.

---

### authPath?

> `optional` **authPath?**: `string`

Defined in: [junior/src/app.ts:103](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L103)

Browser auth route prefix used by Better Auth.

---

### authRequired?

> `optional` **authRequired?**: `boolean`

Defined in: [junior/src/app.ts:105](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L105)

Require a dashboard browser session before serving dashboard pages and APIs.

---

### basePath?

> `optional` **basePath?**: `string`

Defined in: [junior/src/app.ts:111](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L111)

Browser route prefix for the dashboard shell.

---

### baseURL?

> `optional` **baseURL?**: `string`

Defined in: [junior/src/app.ts:113](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L113)

Public deployment origin used for auth callbacks and external links.

---

### disabled?

> `optional` **disabled?**: `boolean`

Defined in: [junior/src/app.ts:115](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L115)

Disable dashboard route mounting while preserving serializable config shape.

---

### mockConversations?

> `optional` **mockConversations?**: `boolean`

Defined in: [junior/src/app.ts:117](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L117)

Overlay dashboard visual-QA fixture conversations onto real reporting data.

---

### reporting?

> `optional` **reporting?**: [`JuniorReporting`](/reference/api/interfaces/juniorreporting/)

Defined in: [junior/src/app.ts:119](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L119)

Reporting implementation used by dashboard APIs. Defaults to core reporting.

---

### sessionMaxAgeSeconds?

> `optional` **sessionMaxAgeSeconds?**: `number`

Defined in: [junior/src/app.ts:121](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L121)

Browser session lifetime in seconds.

---

### trustedOrigins?

> `optional` **trustedOrigins?**: `string`[]

Defined in: [junior/src/app.ts:123](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L123)

Additional trusted origins accepted by Better Auth.
