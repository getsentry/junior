import {
  POST
} from "../chunk-QT3Z6MOH.js";
import {
  GET
} from "../chunk-4RBEYCOG.js";
import "../chunk-OXCKLXL3.js";

// src/handlers/router.ts
function normalizeRoutePath(pathParts) {
  const route = pathParts.join("/").replace(/^\/+|\/+$/g, "");
  return route.startsWith("api/") ? route.slice("api/".length) : route;
}
async function GET2(request, context) {
  const { path } = await context.params;
  const route = normalizeRoutePath(path);
  if (route === "health") {
    return GET();
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
  GET2 as GET,
  POST2 as POST
};
