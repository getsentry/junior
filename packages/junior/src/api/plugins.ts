import { readPlugins } from "../reporting";
import { defineApiRoute } from "./route";
import { pluginsSchema } from "./schema";

/** Serve safe manifest metadata for loaded plugins. */
export default defineApiRoute({
  method: "get",
  path: "/api/plugins",
  responseSchema: pluginsSchema,
  handler: readPlugins,
});
