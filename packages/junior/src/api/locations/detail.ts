import type { User } from "@sentry/junior-plugin-api";
import { locationDetailReportSchema } from "../schema/location";
import { readLocationDetailFromSql } from "./query";
import { defineApiRoute } from "../route";
import { parseParams, throwApiError } from "../http";
import { locationParamsSchema } from "../schema/location";

/** Expose operational detail for one persisted public conversation location. */
export async function readLocationDetail(
  locationId: string,
  options: { viewer?: User } = {},
) {
  const report = await readLocationDetailFromSql(locationId, options);
  return report ? locationDetailReportSchema.parse(report) : undefined;
}

/** Serve one public location detail endpoint. */
export default defineApiRoute({
  method: "get",
  path: "/:locationId",
  responseSchema: locationDetailReportSchema,
  handler: async (c) => {
    const { locationId } = parseParams(locationParamsSchema, c.req.param());
    const viewer = c.get("viewer");
    const report = await readLocationDetail(
      locationId,
      viewer ? { viewer } : {},
    );
    if (!report) throwApiError(404, "Location not found.");
    return report;
  },
});
