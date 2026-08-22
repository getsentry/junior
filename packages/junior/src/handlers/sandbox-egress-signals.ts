import {
  clearSandboxEgressSignals,
  consumeSandboxEgressAuthRequiredSignal,
  consumeSandboxEgressPermissionDeniedSignal,
  parseSandboxEgressCredentialToken,
} from "@/chat/sandbox/egress/session";

const SANDBOX_EGRESS_TOKEN_HEADER = "x-junior-sandbox-egress-token";

function isLoopbackDevelopmentRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return (
    process.env.NODE_ENV === "development" &&
    (hostname === "127.0.0.1" || hostname === "localhost")
  );
}

/** Clear command-scoped sandbox egress signals through the loopback dev server. */
export async function DELETE(request: Request): Promise<Response> {
  if (!isLoopbackDevelopmentRequest(request)) {
    return new Response(null, { status: 404 });
  }
  const context = parseSandboxEgressCredentialToken(
    request.headers.get(SANDBOX_EGRESS_TOKEN_HEADER) ?? "",
  );
  if (!context) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await clearSandboxEgressSignals(context.egressId);
  return new Response(null, { status: 204 });
}

/** Consume command-scoped sandbox egress signals through the loopback dev server. */
export async function GET(request: Request): Promise<Response> {
  if (!isLoopbackDevelopmentRequest(request)) {
    return new Response(null, { status: 404 });
  }
  const context = parseSandboxEgressCredentialToken(
    request.headers.get(SANDBOX_EGRESS_TOKEN_HEADER) ?? "",
  );
  if (!context) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [authRequired, permissionDenied] = await Promise.all([
    consumeSandboxEgressAuthRequiredSignal(context.egressId),
    consumeSandboxEgressPermissionDeniedSignal(context.egressId),
  ]);
  return Response.json({
    ...(authRequired ? { auth_required: authRequired } : undefined),
    ...(permissionDenied ? { permission_denied: permissionDenied } : undefined),
  });
}
