import { readRuntimeInfoReport } from "../reporting";
import { defineApiRoute } from "./route";
import { runtimeInfoReportSchema } from "./schema";

/** Serve Junior runtime build and environment metadata. */
export default defineApiRoute({
  method: "get",
  path: "/api/runtime",
  responseSchema: runtimeInfoReportSchema,
  handler: readRuntimeInfoReport,
});
