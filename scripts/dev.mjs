// `pnpm dev` entry. Runs `dev-server.mjs` inside one
// `sentry local run --session junior`, so Nitro and every restart of it report
// to the `junior` session of the Sentry Local daemon. The session stays
// queryable after `pnpm dev` exits. The wrapper sets `SENTRY_SPOTLIGHT` for its
// child. When it is already set, for example under another
// `sentry local run`, this runs the dev server directly.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "./lib/load-env-files.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(scriptsDir, "..");
const devServer = path.join(scriptsDir, "dev-server.mjs");

// Read the env files into a copy, so that `.env.local` can set
// `OPEN_SPOTLIGHT_WEB`. The dev server loads them itself.
const env = { ...process.env };
loadEnvFiles([workspaceRoot, path.join(workspaceRoot, "apps", "example")], {
  env,
});

if (env.SENTRY_SPOTLIGHT?.trim()) {
  await import(devServer);
} else {
  const openLocalUi = env.OPEN_SPOTLIGHT_WEB?.trim() === "1";
  const wrapper = spawn(
    "pnpm",
    [
      "exec",
      "sentry",
      "local",
      "run",
      ...(openLocalUi ? ["--open"] : []),
      "--session",
      "junior",
      "--",
      process.execPath,
      devServer,
      ...process.argv.slice(2),
    ],
    { cwd: workspaceRoot, stdio: "inherit" },
  );
  // The wrapper passes the signal to the dev server and exits with its code.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => wrapper.kill(signal));
  }
  wrapper.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
