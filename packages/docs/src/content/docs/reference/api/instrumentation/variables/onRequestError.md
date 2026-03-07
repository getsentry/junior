---
editUrl: false
next: false
prev: false
title: "onRequestError"
---

> `const` **onRequestError**: (`error`, `request`, `errorContext`) => `void` = `Sentry.captureRequestError`

Defined in: [instrumentation.ts:56](https://github.com/getsentry/junior/blob/d10f23a338adf19a5bcb5c5720a182dc8e05b5a5/packages/junior/src/instrumentation.ts#L56)

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
