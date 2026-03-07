---
editUrl: false
next: false
prev: false
title: "POST"
---

> **POST**(`request`, `context`): `Promise`\<`Response`\>

Defined in: [handlers/router.ts:48](https://github.com/getsentry/junior/blob/d10f23a338adf19a5bcb5c5720a182dc8e05b5a5/packages/junior/src/handlers/router.ts#L48)

Handles all POST requests routed through `@sentry/junior/handler`.

Supported routes:
- `api/webhooks/:platform`

## Parameters

### request

`Request`

### context

`RouteContext`

## Returns

`Promise`\<`Response`\>
