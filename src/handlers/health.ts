export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  return Response.json({
    status: "ok",
    service: "junior",
    timestamp: new Date().toISOString()
  });
}
