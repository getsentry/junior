import { healthReportSchema } from "@/reporting-schema";
import type { HealthReport } from "@/reporting-schema";

/** Build Junior's process health value for HTTP and reporting consumers. */
export function readHealthReport(): HealthReport {
  return healthReportSchema.parse({
    status: "ok",
    service: "junior",
    timestamp: new Date().toISOString(),
  });
}

/**
 * Returns a minimal JSON health response for runtime health checks.
 */
export function GET(): Response {
  return Response.json(readHealthReport());
}
