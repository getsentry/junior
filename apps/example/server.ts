import { createApp } from "@sentry/junior";
import { initSentry } from "@sentry/junior/instrumentation";
import { examplePluginPackages } from "./plugin-packages";

initSentry();

const app = await createApp({ pluginPackages: examplePluginPackages });

export default app;
