import { locationDirectoryReportSchema } from "./schema";
import { readLocationDirectoryFromSql } from "./query";
import type { ApiRoute } from "../route";

/** Expose public conversation destinations as the dashboard's location index. */
export async function readLocationDirectory() {
  return locationDirectoryReportSchema.parse(
    await readLocationDirectoryFromSql(),
  );
}

/** Serve the public location directory endpoint. */
export default {
  method: "get",
  path: "/",
  handler: async () => Response.json(await readLocationDirectory()),
} satisfies ApiRoute;
