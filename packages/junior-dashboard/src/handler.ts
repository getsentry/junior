import { defineHandler } from "nitro";
import { createDashboardApp } from "./app";
import { resolveDashboardConfig } from "./config";

let app: ReturnType<typeof createDashboardApp> | undefined;

const handler: unknown = defineHandler(async (event) => {
  const dashboardApp =
    app ?? createDashboardApp(await resolveDashboardConfig());
  app = dashboardApp;
  return dashboardApp.fetch(event.req);
});

export default handler;
