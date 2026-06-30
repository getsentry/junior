import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const envPath = path.join(workspaceRoot, ".env.local");
const requestedTunnelName = process.argv[2]?.trim();
const tunnelName =
  requestedTunnelName ||
  process.env.CLOUDFLARE_TUNNEL_NAME?.trim() ||
  "junior-dev";

const tokenResult = spawnSync("cloudflared", ["tunnel", "token", tunnelName], {
  cwd: workspaceRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

if (tokenResult.error) {
  throw tokenResult.error;
}

if (tokenResult.status !== 0) {
  process.exit(tokenResult.status ?? 1);
}

const token = tokenResult.stdout.trim();
if (!token) {
  throw new Error(`cloudflared returned an empty token for "${tunnelName}"`);
}

const nextLine = `CLOUDFLARE_TUNNEL_TOKEN=${JSON.stringify(token)}`;
const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
const nextContent = /^CLOUDFLARE_TUNNEL_TOKEN=.*$/m.test(existing)
  ? existing.replace(/^CLOUDFLARE_TUNNEL_TOKEN=.*$/m, nextLine)
  : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${nextLine}\n`;

fs.writeFileSync(envPath, nextContent, "utf8");
process.stdout.write(
  `Updated ${path.relative(workspaceRoot, envPath)} with CLOUDFLARE_TUNNEL_TOKEN for ${tunnelName}.\n`,
);
