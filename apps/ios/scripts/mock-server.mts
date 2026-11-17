// Serves the built dashboard with its mock reporting data, so the iOS app can
// run against real API shapes without Slack, a database, or a sign-in.
import { createServer } from "node:http";
import { Readable } from "node:stream";

process.env["DATABASE_URL"] ??= "postgres://localhost/junior-ios-mock";
process.env["JUNIOR_ENCRYPTION_KEYS"] ??=
  "ios:Wywm9DZHe0QkHOXon30I5fklwG0gdqLAzMViptFlvtI";

const port = Number(process.env["PORT"] ?? 4317);
// The built dashboard: run `pnpm --filter "@sentry/junior-dashboard..." build`
// first. This script needs only these two exports.
type DashboardModule = {
  createDashboardApp(options: Record<string, unknown>): {
    fetch(request: Request): Promise<Response>;
  };
  resetMockDashboardState(): void;
};
const dashboard: DashboardModule =
  await import("../../../packages/junior-dashboard/dist/app.js");
const { createDashboardApp, resetMockDashboardState } = dashboard;
const app = createDashboardApp({
  agentName: "Junior",
  allowedDomains: ["example.com"],
  auth: {
    async getSession() {
      return {
        user: {
          email: "dev@example.com",
          emailVerified: true,
          name: "Dashboard User",
        },
      };
    },
    async handler() {
      return Response.json({ ok: true });
    },
    async signInWithGoogle() {
      return Response.redirect("https://accounts.google.com", 302);
    },
  },
  mockConversations: true,
});

const baseURL = `http://127.0.0.1:${port}`;
createServer((req, res) => {
  // UI tests call this before each journey so earlier writes do not leak.
  if (req.method === "POST" && req.url === "/__reset") {
    resetMockDashboardState();
    res.statusCode = 204;
    res.end();
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(new URL(req.url ?? "/", baseURL), {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: hasBody ? "half" : undefined,
  } as RequestInit);
  void app
    .fetch(request)
    .then(async (response: Response) => {
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    })
    .catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.stack : String(error));
    });
}).listen(port, "127.0.0.1", () => {
  console.log(`Junior mock dashboard on ${baseURL}`);
});
