---
editUrl: false
next: false
prev: false
title: "JuniorDashboardOptions"
---

Defined in: [junior/src/app.ts:104](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L104)

## Properties

### allowedEmails?

> `optional` **allowedEmails?**: `string`[]

Defined in: [junior/src/app.ts:110](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L110)

Exact Google account emails allowed to open the dashboard.

---

### allowedGoogleDomains?

> `optional` **allowedGoogleDomains?**: `string`[]

Defined in: [junior/src/app.ts:112](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L112)

Google Workspace domains allowed to open the dashboard.

---

### authPath?

> `optional` **authPath?**: `string`

Defined in: [junior/src/app.ts:106](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L106)

Browser auth route prefix used by Better Auth.

---

### authRequired?

> `optional` **authRequired?**: `boolean`

Defined in: [junior/src/app.ts:108](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L108)

Require a dashboard browser session before serving dashboard pages and APIs.

---

### basePath?

> `optional` **basePath?**: `string`

Defined in: [junior/src/app.ts:114](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L114)

Browser route prefix for the dashboard shell.

---

### baseURL?

> `optional` **baseURL?**: `string`

Defined in: [junior/src/app.ts:116](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L116)

Public deployment origin used for auth callbacks and external links.

---

### disabled?

> `optional` **disabled?**: `boolean`

Defined in: [junior/src/app.ts:118](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L118)

Disable dashboard route mounting while preserving serializable config shape.

---

### mockConversations?

> `optional` **mockConversations?**: `boolean`

Defined in: [junior/src/app.ts:120](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L120)

Overlay dashboard visual-QA fixture conversations onto real reporting data.

---

### reporting?

> `optional` **reporting?**: [`JuniorReporting`](/reference/api/interfaces/juniorreporting/)

Defined in: [junior/src/app.ts:122](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L122)

Reporting implementation used by authenticated product APIs. Defaults to core reporting.

---

### sessionMaxAgeSeconds?

> `optional` **sessionMaxAgeSeconds?**: `number`

Defined in: [junior/src/app.ts:124](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L124)

Browser session lifetime in seconds.

---

### trustedOrigins?

> `optional` **trustedOrigins?**: `string`[]

Defined in: [junior/src/app.ts:126](https://github.com/getsentry/junior/blob/main/packages/junior/src/app.ts#L126)

Additional trusted origins accepted by Better Auth.
