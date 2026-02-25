export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    status: "ok",
    service: "shim",
    timestamp: new Date().toISOString()
  });
}
