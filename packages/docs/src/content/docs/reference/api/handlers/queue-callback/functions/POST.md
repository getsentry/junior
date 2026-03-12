---
editUrl: false
next: false
prev: false
title: "POST"
---

> **POST**(`request`): `Promise`\<`Response`\>

Defined in: [handlers/queue-callback.ts:59](https://github.com/getsentry/junior/blob/main/packages/junior/src/handlers/queue-callback.ts#L59)

Handles `POST /api/queue/callback` for asynchronous thread processing.

Keep this route as a dedicated handler in app code. The catch-all router can
mirror this path for local/dev parity, but production queue delivery should
always target the dedicated endpoint.

## Parameters

### request

`Request`

## Returns

`Promise`\<`Response`\>
