import { locationDetailReportSchema } from "./schema";
import { readLocationDetailFromSql } from "./query";
import type { ApiRoute } from "../route";
import { parseParams } from "../http";
import { locationParamsSchema } from "../schema";

/** Expose operational detail for one persisted public conversation location. */
export async function readLocationDetail(locationId: string) {
  const report = await readLocationDetailFromSql(locationId);
  return report ? locationDetailReportSchema.parse(report) : undefined;
}

/** Serve one public location detail endpoint. */
export default {
  method: "get",
  path: "/:locationId",
  handler: async (c) => {
    const { locationId } = parseParams(locationParamsSchema, c.req.param());
    const report = await readLocationDetail(locationId);
    return report
      ? Response.json(report)
      : Response.json({ error: "Location not found." }, { status: 404 });
  },
} satisfies ApiRoute;
