import { locationDirectoryReportSchema } from "../schema/location";
import { readLocationDirectoryFromSql } from "./query";
import { defineApiRoute } from "../route";

/** Expose public conversation destinations as the dashboard's location index. */
export async function readLocationDirectory() {
  return locationDirectoryReportSchema.parse(
    await readLocationDirectoryFromSql(),
  );
}

/** Serve the public location directory endpoint. */
export default defineApiRoute({
  method: "get",
  path: "/",
  responseSchema: locationDirectoryReportSchema,
  handler: readLocationDirectory,
});
