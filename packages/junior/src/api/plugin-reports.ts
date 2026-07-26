import { readPluginOperationalReportFeed } from "../reporting";
import { defineApiRoute } from "./route";
import { pluginOperationalReportFeedSchema } from "./schema";

/** Serve operational reports contributed by loaded plugins. */
export default defineApiRoute({
  method: "get",
  path: "/api/plugin-reports",
  responseSchema: pluginOperationalReportFeedSchema,
  handler: readPluginOperationalReportFeed,
});
