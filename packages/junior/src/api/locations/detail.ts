import { locationDetailReportSchema } from "./schema";
import { readLocationDetailFromSql } from "./query";

/** Expose operational detail for one persisted public conversation location. */
export async function readLocationDetail(locationId: string) {
  const report = await readLocationDetailFromSql(locationId);
  return report ? locationDetailReportSchema.parse(report) : undefined;
}
