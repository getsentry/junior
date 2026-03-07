---
editUrl: false
next: false
prev: false
title: "GET"
---

> **GET**(`request`, `context`): `Promise`\<`Response`\>

Defined in: [handlers/router.ts:23](https://github.com/getsentry/junior/blob/main/packages/junior/src/handlers/router.ts#L23)

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
