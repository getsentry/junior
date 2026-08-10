import type { User } from "@sentry/junior-plugin-api";
import { locationDetailReportSchema } from "../schema/location";
import { readLocationDetailFromSql } from "./query";

/** Expose operational detail for one persisted public conversation location. */
export async function readLocationDetail(
  locationId: string,
  options: { viewer?: User } = {},
) {
  const report = await readLocationDetailFromSql(locationId, options);
  return report ? locationDetailReportSchema.parse(report) : undefined;
}
