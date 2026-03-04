// src/handlers/health.ts
async function GET() {
  return Response.json({
    status: "ok",
    service: "junior",
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
}

export {
  GET
};
