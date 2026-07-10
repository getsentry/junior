/** Sentry SDK re-export. Isolates the concrete package to a single file. */
export {
  captureException,
  captureMessage,
  continueTrace,
  flush,
  getActiveSpan,
  getClient,
  getGlobalScope,
  getTraceData,
  init,
  logger,
  setTag,
  setUser,
  spanToJSON,
  startInactiveSpan,
  startSpan,
  vercelAIIntegration,
  withActiveSpan,
  withScope,
  withStreamedSpan,
} from "@sentry/node";
export * from "@sentry/node";
