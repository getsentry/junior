import { Hono } from "hono";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  locationParamsSchema,
} from "../schema/location";
import { validateRequest } from "../validation";
import { readLocationDetail } from "./detail";
import { readLocationDirectory } from "./list";

/** Create the HTTP routes owned by the locations API. */
export function createLocationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", async () =>
    jsonResponse(locationDirectoryReportSchema, await readLocationDirectory()),
  );

  app.get(
    "/:locationId",
    validateRequest(
      "param",
      locationParamsSchema,
      "Invalid route parameters.",
    ),
    async (context) => {
      const { locationId } = context.req.valid("param");
      const viewer = context.get("viewer");
      const report = await readLocationDetail(
        locationId,
        viewer ? { viewer } : {},
      );
      if (!report) throwApiError(404, "Location not found.");
      return jsonResponse(locationDetailReportSchema, report);
    },
  );

  return app;
}
