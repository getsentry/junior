/**
 * Returns a minimal JSON health response for runtime health checks.
 */
export async function GET(): Promise<Response> {
  return Response.json({
    status: "ok",
    service: "junior",
    timestamp: new Date().toISOString()
  });
}
