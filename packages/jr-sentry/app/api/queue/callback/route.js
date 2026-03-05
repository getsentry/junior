export { POST } from "@sentry/junior/handlers/queue-callback";
export const runtime = "nodejs";
// Keep this aligned with QUEUE_CALLBACK_MAX_DURATION_SECONDS default.
export const maxDuration = 800;
