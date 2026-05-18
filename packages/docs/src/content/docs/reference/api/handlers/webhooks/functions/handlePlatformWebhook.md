---
editUrl: false
next: false
prev: false
title: "handlePlatformWebhook"
---

> **handlePlatformWebhook**(`request`, `platform`, `waitUntil`, `bot`): `Promise`\<`Response`\>

Defined in: [handlers/webhooks.ts:22](https://github.com/getsentry/junior/blob/main/packages/junior/src/handlers/webhooks.ts#L22)

Handles `POST /api/webhooks/:platform`.

The router only resolves the platform and delegates to the adapter webhook
implementation; request semantics stay owned by the adapter package.

Platform-owned preprocessors may rebuild the request before delegation when
an adapter has side-channel behavior the generic router should not own.

## Parameters

### request

`Request`

### platform

`string`

### waitUntil

`WaitUntilFn`

### bot

`ProductionBot`

## Returns

`Promise`\<`Response`\>
