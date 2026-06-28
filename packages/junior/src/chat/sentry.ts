/** Sentry SDK re-export. Isolates the concrete package to a single file. */
export {
  captureException,
  continueTrace,
  flush,
  getClient,
  getGlobalScope,
  init,
  setTag,
  setUser,
  startInactiveSpan,
  startSpan,
  vercelAIIntegration,
  withActiveSpan,
  withScope,
  withStreamedSpan,
} from "@sentry/node";
export * from "@sentry/node";
