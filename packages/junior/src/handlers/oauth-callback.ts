type OAuthCallbackRouteContext = {
  params: Promise<{
    provider: string;
  }>;
};

async function loadOAuthRoute() {
  return import("@/../app/api/oauth/callback/[provider]/route");
}

export async function GET(
  request: Request,
  context: OAuthCallbackRouteContext
): Promise<Response> {
  const route = await loadOAuthRoute();
  return route.GET(request, context);
}
