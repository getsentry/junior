import { Hono } from "hono";
import { jsonResponse, throwApiError } from "../http";
import type { JuniorApiEnv } from "../route";
import {
  locationDetailReportSchema,
  locationDirectoryReportSchema,
  locationParamsSchema,
} from "../schema/location";
import { validateRequest } from "../validation";
import {
  readLocationDetailFromSql,
  readLocationDirectoryFromSql,
} from "./query";

/** Create the HTTP routes owned by the locations API. */
export function createLocationRoutes(): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();

  app.get("/", async () =>
    jsonResponse(
      locationDirectoryReportSchema,
      await readLocationDirectoryFromSql(),
    ),
  );

  app.get(
    "/:locationId",
    validateRequest("param", locationParamsSchema, "Invalid route parameters."),
    async (context) => {
      const { locationId } = context.req.valid("param");
      const viewer = context.get("viewer");
      const report = await readLocationDetailFromSql(
        locationId,
        viewer ? { viewer } : {},
      );
      if (!report) throwApiError(404, "Location not found.");
      return jsonResponse(locationDetailReportSchema, report);
    },
  );

  return app;
}
