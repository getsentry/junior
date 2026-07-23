import { locationDetailReportSchema } from "../schema/location";
import { readLocationDetailFromSql } from "./query";
import { defineApiRoute } from "../route";
import { parseParams, throwApiError } from "../http";
import { locationParamsSchema } from "../schema/location";

/** Expose operational detail for one persisted public conversation location. */
export async function readLocationDetail(
  locationId: string,
  options: { verifiedViewerEmail?: string } = {},
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
    const verifiedViewerEmail = c.get("verifiedViewerEmail");
    const report = await readLocationDetail(
      locationId,
      verifiedViewerEmail ? { verifiedViewerEmail } : {},
    );
    if (!report) throwApiError(404, "Location not found.");
    return report;
  },
});
