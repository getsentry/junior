---
editUrl: false
next: false
prev: false
title: "POST"
---

> **POST**(`request`, `context`): `Promise`\<`Response`\>

Defined in: [handlers/webhooks.ts:30](https://github.com/getsentry/junior/blob/a6f3331e28b1f6197b4b4c511429d71b54bf5258/packages/junior/src/handlers/webhooks.ts#L30)

Handles platform webhook POST requests for Junior.

This endpoint resolves a platform adapter from the route context and delegates
request handling to the adapter webhook handler.

## Parameters

### request

`Request`

### context

`WebhookRouteContext`

## Returns

`Promise`\<`Response`\>
