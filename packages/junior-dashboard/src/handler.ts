import { defineHandler } from "nitro";
import { createDashboardApp } from "./app";
import { resolveDashboardConfig } from "./config";

let app: ReturnType<typeof createDashboardApp> | undefined;
let appPromise: Promise<ReturnType<typeof createDashboardApp>> | undefined;

async function resolveApp(): Promise<ReturnType<typeof createDashboardApp>> {
  appPromise ??= resolveDashboardConfig()
    .then((config) => {
      app = createDashboardApp(config);
      return app;
    })
    .catch((error: unknown) => {
      appPromise = undefined;
      throw error;
    });
  return app ?? appPromise;
}

const handler: unknown = defineHandler(async (event) => {
  const dashboardApp = await resolveApp();
  return dashboardApp.fetch(event.req);
});

export default handler;
