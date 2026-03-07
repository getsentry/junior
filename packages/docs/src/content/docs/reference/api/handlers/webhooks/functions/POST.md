---
editUrl: false
next: false
prev: false
title: "POST"
---

> **POST**(`request`, `context`): `Promise`\<`Response`\>

Defined in: [handlers/webhooks.ts:30](https://github.com/getsentry/junior/blob/d10f23a338adf19a5bcb5c5720a182dc8e05b5a5/packages/junior/src/handlers/webhooks.ts#L30)

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
