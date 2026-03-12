---
editUrl: false
next: false
prev: false
title: "POST"
---

> **POST**(`request`, `context`): `Promise`\<`Response`\>

Defined in: [handlers/webhooks.ts:37](https://github.com/getsentry/junior/blob/main/packages/junior/src/handlers/webhooks.ts#L37)

Handles `POST /api/webhooks/:platform`.

The router only resolves the platform and delegates to the adapter webhook
implementation; request semantics stay owned by the adapter package.

## Parameters

### request

`Request`

### context

`WebhookRouteContext`

## Returns

`Promise`\<`Response`\>
