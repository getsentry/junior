import {
  POST
} from "../chunk-T3FOR7K6.js";
import {
  GET
} from "../chunk-4RBEYCOG.js";
import "../chunk-OXCKLXL3.js";

// src/handlers/oauth-callback.ts
async function loadOAuthRoute() {
  return import("../route-ZYASKU6H.js");
}
async function GET2(request, context) {
  const route = await loadOAuthRoute();
  return route.GET(request, context);
}

// src/handlers/router.ts
function normalizeRoutePath(pathParts) {
  const route = pathParts.join("/").replace(/^\/+|\/+$/g, "");
  return route.startsWith("api/") ? route.slice("api/".length) : route;
}
async function GET3(request, context) {
  const { path } = await context.params;
  const route = normalizeRoutePath(path);
  if (route === "health") {
    return GET();
  }
  const oauthCallbackMatch = route.match(/^oauth\/callback\/([^/]+)$/);
  if (oauthCallbackMatch) {
    const provider = oauthCallbackMatch[1];
    return GET2(request, {
      params: Promise.resolve({ provider })
    });
  }
  return new Response("Not Found", { status: 404 });
}
async function POST2(request, context) {
  const { path } = await context.params;
  const route = normalizeRoutePath(path);
  const webhookMatch = route.match(/^webhooks\/([^/]+)$/);
  if (webhookMatch) {
    const platform = webhookMatch[1];
    return POST(request, {
      params: Promise.resolve({ platform })
    });
  }
  return new Response("Not Found", { status: 404 });
}
export {
  GET3 as GET,
  POST2 as POST
};
