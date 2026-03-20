import { afterCallbacks } from "./oauth-callback-after-harness";

export async function runOauthCallbackRoute(args: {
  provider: string;
  state: string;
  code: string;
}) {
  afterCallbacks.length = 0;
  const { GET } = await import("@/handlers/router");
  const response = await GET(
    new Request(
      `https://junior.example.com/api/oauth/callback/${args.provider}?state=${encodeURIComponent(args.state)}&code=${encodeURIComponent(args.code)}`,
      { method: "GET" },
    ),
    {
      params: Promise.resolve({
        path: ["oauth", "callback", args.provider],
      }),
    },
  );
  const callbacks = afterCallbacks.splice(0, afterCallbacks.length);
  for (const callback of callbacks) {
    await callback();
  }
  if (response.status === 200 && callbacks.length === 0) {
    throw new Error(
      `OAuth callback route returned 200 without registering after() work for provider "${args.provider}"`,
    );
  }
  return response;
}
