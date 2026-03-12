---
editUrl: false
next: false
prev: false
title: "POST"
---

> **POST**(`request`, `context`): `Promise`\<`Response`\>

Defined in: [handlers/router.ts:68](https://github.com/getsentry/junior/blob/main/packages/junior/src/handlers/router.ts#L68)

Handles all POST requests routed through `@sentry/junior/handler`.

Supported routes:

- `api/webhooks/:platform`
- `api/queue/callback`

`queue/callback` is routed here for local/dev parity, but production queue triggers
should still target the dedicated `app/api/queue/callback/route.ts` endpoint.

## Parameters

### request

`Request`

### context

`RouteContext`

## Returns

`Promise`\<`Response`\>
