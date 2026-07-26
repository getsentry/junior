import {
  clearSandboxEgressSignals,
  consumeSandboxEgressAuthRequiredSignal,
  consumeSandboxEgressPermissionDeniedSignal,
  parseSandboxEgressCredentialToken,
} from "@/chat/sandbox/egress/session";

/** Clear command-scoped sandbox egress signals through a signed context token. */
export async function DELETE(token: string): Promise<Response> {
  const context = parseSandboxEgressCredentialToken(token);
  if (!context) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await clearSandboxEgressSignals(context.egressId);
  return new Response(null, { status: 204 });
}

/** Consume command-scoped sandbox egress signals through a signed context token. */
export async function GET(token: string): Promise<Response> {
  const context = parseSandboxEgressCredentialToken(token);
  if (!context) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const [authRequired, permissionDenied] = await Promise.all([
    consumeSandboxEgressAuthRequiredSignal(context.egressId),
    consumeSandboxEgressPermissionDeniedSignal(context.egressId),
  ]);
  return Response.json({
    ...(authRequired ? { auth_required: authRequired } : {}),
    ...(permissionDenied ? { permission_denied: permissionDenied } : {}),
  });
}
