import { readHealthReport } from "../reporting";
import { defineApiRoute } from "./route";
import { healthReportSchema } from "./schema";

/** Serve Junior's authenticated health report. */
export default defineApiRoute({
  method: "get",
  path: "/api/health",
  responseSchema: healthReportSchema,
  handler: readHealthReport,
});
