---
editUrl: false
next: false
prev: false
title: "GET"
---

> **GET**(`request`, `context`): `Promise`\<`Response`\>

Defined in: [handlers/router.ts:23](https://github.com/getsentry/junior/blob/d10f23a338adf19a5bcb5c5720a182dc8e05b5a5/packages/junior/src/handlers/router.ts#L23)

Handles all GET requests routed through `@sentry/junior/handler`.

Supported routes:
- `api/health`
- `api/oauth/callback/:provider`

## Parameters

### request

`Request`

### context

`RouteContext`

## Returns

`Promise`\<`Response`\>
