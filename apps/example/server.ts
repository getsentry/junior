import { createApp } from "@sentry/junior";
import { initSentry } from "@sentry/junior/instrumentation";

initSentry();

const app = await createApp();

export default app;
