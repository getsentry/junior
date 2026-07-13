import { locationDirectoryReportSchema } from "./schema";
import { readLocationDirectoryFromSql } from "./query";

/** Expose public conversation destinations as the dashboard's location index. */
export async function readLocationDirectory() {
  return locationDirectoryReportSchema.parse(
    await readLocationDirectoryFromSql(),
  );
}
