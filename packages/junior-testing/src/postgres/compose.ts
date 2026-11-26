import { execFile } from "node:child_process";
import { connect } from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The host port of the postgres service in compose.yaml.
const COMPOSE_POSTGRES_PORT = "54322";
const COMPOSE_ARGS = ["compose", "up", "-d", "--wait", "postgres"];

function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(1_000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

/**
 * Start the compose.yaml Postgres for a local test run when it is not up.
 * GitHub Actions runs Postgres as a job service, and a URL on another port is
 * a database that the developer runs, so neither starts compose. This checks
 * `GITHUB_ACTIONS`, not `CI`, because agent sandboxes also set `CI`.
 */
export async function ensureComposePostgres(
  connectionString: string,
): Promise<void> {
  const { hostname, port } = new URL(connectionString);
  if (process.env["GITHUB_ACTIONS"] || port !== COMPOSE_POSTGRES_PORT) {
    return;
  }
  if (await isPortOpen(hostname, Number(port))) {
    return;
  }
  try {
    // Compose finds the repo-root compose.yaml from the package directory.
    await execFileAsync("docker", COMPOSE_ARGS, { timeout: 120_000 });
  } catch (error) {
    const detail =
      (error as { code?: unknown }).code === "ENOENT"
        ? "docker is not installed or not on PATH"
        : (error as { stderr?: string }).stderr?.trim() || String(error);
    throw new Error(
      `Postgres is not reachable at ${hostname}:${port} and could not be started (${detail}). Start it from the repo root with \`docker ${COMPOSE_ARGS.join(" ")}\`.`,
      { cause: error },
    );
  }
}
