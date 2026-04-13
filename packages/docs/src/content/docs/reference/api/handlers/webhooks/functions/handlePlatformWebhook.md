---
editUrl: false
next: false
prev: false
title: "handlePlatformWebhook"
---

> **handlePlatformWebhook**(`request`, `platform`, `waitUntil`, `bot?`): `Promise`\<`Response`\>

Defined in: [handlers/webhooks.ts:117](https://github.com/getsentry/junior/blob/main/packages/junior/src/handlers/webhooks.ts#L117)

Handles `POST /api/webhooks/:platform`.

The router only resolves the platform and delegates to the adapter webhook
implementation; request semantics stay owned by the adapter package.

For Slack, the body is read once and used to detect `message_changed` events
that introduce a new bot @mention, which the Slack adapter silently ignores.
The request is then reconstructed so the adapter can consume it normally.

## Parameters

### request

`Request`

### platform

`string`

### waitUntil

`WaitUntilFn`

### bot?

`JuniorChat`\<\{ `slack`: `SlackAdapter`; \}\> = `...`

## Returns

`Promise`\<`Response`\>
