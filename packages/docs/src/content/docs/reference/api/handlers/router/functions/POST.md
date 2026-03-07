---
editUrl: false
next: false
prev: false
title: "POST"
---

> **POST**(`request`, `context`): `Promise`\<`Response`\>

Defined in: [handlers/router.ts:48](https://github.com/getsentry/junior/blob/a6f3331e28b1f6197b4b4c511429d71b54bf5258/packages/junior/src/handlers/router.ts#L48)

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
