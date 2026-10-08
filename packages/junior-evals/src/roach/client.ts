/**
 * The client of Roach. See `README.md` in this directory.
 *
 * `spawnRoach()` starts the proxy in its own process and returns
 * `env`, the variables that send the traffic of a process through it.
 * `connectRoach()` controls a running proxy from another process,
 * such as a test worker.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_PATH } from "./server.ts";
import type { RoachAddress, RoachConfig, RecordingStats } from "./types.ts";

/** The open session of one test. */
export interface RecordingSession {
  /**
   * End the session. A passed session writes its new recordings, and a
   * failed one drops them. `missed` counts the requests of the session that
   * `replay` mode failed. A test with a miss must fail.
   */
  end(passed: boolean): Promise<{ missed: number }>;
}

/** The control API of a running proxy. */
export interface RoachControl {
  /** Open the session of one test. Only one session is open at a time. */
  startSession(name: string): Promise<RecordingSession>;
  /** The totals of the run. */
  stats(): Promise<RecordingStats>;
}

/** A proxy that `spawnRoach()` started. */
export interface Roach extends RoachAddress, RoachControl {
  /**
   * The variables that send the HTTP traffic of a process through the
   * proxy: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`,
   * and `NODE_EXTRA_CA_CERTS`. Give them to a process when it starts. Node
   * reads the last two only at startup.
   */
  env: Record<string, string>;
  /** Stop the proxy. It then writes `usedFile` of its config. */
  close(): Promise<void>;
}

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

/** Proxy variables. The proxy itself must not use a proxy. */
const PROXY_VARIABLES = new Set([
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "node_use_env_proxy",
]);

/** Call the control API, and return the JSON of the response. */
function callControl<T>(
  address: Pick<RoachAddress, "token" | "url">,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${address.url}${CONTROL_PATH}/${route}`,
      {
        // Its own agent, so that a proxy agent of the process is not used.
        agent: false,
        method,
        headers: {
          authorization: `Bearer ${address.token}`,
          ...(payload ? { "content-type": "application/json" } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 500;
          if (status >= 400) {
            reject(
              new Error(
                `Roach ${method} ${route} failed with HTTP ${status}: ${text}`,
              ),
            );
          } else {
            resolve((text ? JSON.parse(text) : undefined) as T);
          }
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

/** Control a running proxy, for example from a test worker. */
export function connectRoach(
  address: Pick<RoachAddress, "token" | "url">,
): RoachControl {
  return {
    async startSession(name) {
      await callControl(address, "POST", "session", { name });
      return {
        end: (passed) =>
          callControl(address, "POST", "session/end", { name, passed }),
      };
    },
    stats: () => callControl(address, "GET", "stats"),
  };
}

/** Read the address line that `cli.ts serve` prints. */
function readAddress(child: ReturnType<typeof spawn>): Promise<RoachAddress> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Roach exited with code ${code}`)),
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const end = output.indexOf("\n");
      if (end >= 0) resolve(JSON.parse(output.slice(0, end)));
    });
  });
}

/**
 * Start the proxy in its own process.
 *
 * `launcher` is a command prefix that runs the proxy, such as `sudo`. Use it
 * when the caller cannot reach the network, but the proxy must. `noProxy`
 * lists the hosts that do not use the proxy, such as `localhost`.
 */
export async function spawnRoach(
  config: RoachConfig,
  {
    launcher = [],
    noProxy = "localhost,127.0.0.1,::1",
  }: { launcher?: string[]; noProxy?: string } = {},
): Promise<Roach> {
  const command = [
    ...launcher,
    process.execPath,
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    CLI,
    "serve",
  ];
  const child = spawn(command[0]!, command.slice(1), {
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !PROXY_VARIABLES.has(name.toLowerCase()),
      ),
    ),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.stdin.end(JSON.stringify(config));
  const address = await readAddress(child);
  // `NODE_EXTRA_CA_CERTS` takes a file.
  const caDirectory = await mkdtemp(path.join(tmpdir(), "roach-"));
  const caFile = path.join(caDirectory, "ca.pem");
  await writeFile(caFile, address.caCert);

  return {
    ...address,
    ...connectRoach(address),
    env: {
      HTTP_PROXY: address.url,
      HTTPS_PROXY: address.url,
      NO_PROXY: noProxy,
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caFile,
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      await rm(caDirectory, { force: true, recursive: true });
    },
  };
}
