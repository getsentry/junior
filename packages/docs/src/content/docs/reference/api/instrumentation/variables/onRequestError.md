---
editUrl: false
next: false
prev: false
title: "onRequestError"
---

> `const` **onRequestError**: (`error`, `request`, `errorContext`) => `void` = `Sentry.captureRequestError`

Defined in: [instrumentation.ts:56](https://github.com/getsentry/junior/blob/main/packages/junior/src/instrumentation.ts#L56)

Re-export of Sentry request error handler for Next.js instrumentation wiring.

Reports errors passed to the the Next.js `onRequestError` instrumentation hook.

## Parameters

### error

`unknown`

### request

`RequestInfo`

### errorContext

`ErrorContext`

## Returns

`void`
