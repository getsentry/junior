// Prototype only: serve the built dashboard with mock reporting and a fake
// signed-in session, like the e2e harness, so Inbox and Automations show.
// No provider credentials. Run after `pnpm --filter @sentry/junior-dashboard build`.
import { createServer } from "node:http";
import { Readable } from "node:stream";

process.env.DATABASE_URL ??= "postgres://localhost/junior-dashboard-prototype";
const { createDashboardApp } = await import("../dist/app.js");
const app = createDashboardApp({
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

// Mock data is dated around one fixed instant. Shift the browser clock to it,
// so "Today" and relative times read as they would on a live install.
const MOCK_NOW_MS = Date.parse("2026-08-07T12:00:00.000Z");
const CLOCK_SHIM = `<script>(()=>{const R=Date,o=${MOCK_NOW_MS}-R.now();class D extends R{constructor(...a){a.length?super(...a):super(R.now()+o)}static now(){return R.now()+o}}window.Date=D})();</script>`;

const port = Number(process.env.PORT ?? 3001);
createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const body =
    method === "GET" || method === "HEAD" ? undefined : Readable.toWeb(req);
  void app
    .fetch(
      new Request(url, {
        body,
        duplex: body ? "half" : undefined,
        headers,
        method,
      }),
    )
    .then(async (response) => {
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      if (response.headers.get("content-type")?.startsWith("text/html")) {
        const html = (await response.text()).replace(
          "<head>",
          `<head>${CLOCK_SHIM}`,
        );
        res.removeHeader("content-length");
        res.end(html);
        return;
      }
      res.end(Buffer.from(await response.arrayBuffer()));
    })
    .catch((error) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.stack : String(error));
    });
}).listen(port, "0.0.0.0", () => console.log(`prototype on :${port}`));
