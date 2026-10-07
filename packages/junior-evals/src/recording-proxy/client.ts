/**
 * The client of the recording proxy. See `README.md` in this directory.
 *
 * `spawnRecordingProxy()` starts the proxy in its own process and returns
 * `env`, the variables that send the traffic of a process through it.
 * `connectRecordingProxy()` controls a running proxy from another process,
 * such as a test worker. Like the server, this file uses only Node
 * built-ins.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RecordingMiss,
  RecordingProxyConfig,
  RecordingRunStats,
} from "./recording-proxy";
import { describeParts } from "./request-parts.ts";

/** The address of a running proxy. Give it to other processes. */
export interface RecordingProxyAddress {
  /** The proxy URL, such as `http://127.0.0.1:1234`. */
  url: string;
  /** The bearer token of the control API. */
  token: string;
  /** The PEM certificate that clients must trust. */
  caCert: string;
}

/** The control API of a running proxy. */
export interface RecordingProxyControl {
  /**
   * Open the session of one test. The proxy keeps its new recordings until
   * `endSession()`. Only one session is open at a time.
   */
  startSession(name: string): Promise<void>;
  /**
   * End the session. A passed session writes its recordings. `missed`
   * counts the requests of the session that `replay` mode failed, because
   * they had no recording. A test with a miss must fail.
   */
  endSession(passed: boolean): Promise<{ missed: number }>;
  /** The totals of the run. */
  stats(): Promise<RecordingRunStats>;
}

/** A proxy that `spawnRecordingProxy()` started. */
export interface RecordingProxy
  extends RecordingProxyAddress, RecordingProxyControl {
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

const SERVER = fileURLToPath(new URL("./recording-proxy.ts", import.meta.url));

/** Proxy variables. The proxy itself must not use a proxy. */
const PROXY_VARIABLES = new Set([
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "node_use_env_proxy",
]);

/** Call the control API of the proxy. */
function callControl(
  address: Pick<RecordingProxyAddress, "token" | "url">,
  method: "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<string> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${address.url}/__recording-proxy/${route}`,
      {
        // A new agent, so that a proxy agent of the process is not used.
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
          if ((response.statusCode ?? 500) >= 400) {
            reject(
              new Error(
                `Recording proxy ${method} ${route} failed with HTTP ${response.statusCode}: ${text}`,
              ),
            );
          } else {
            resolve(text);
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
export function connectRecordingProxy(
  address: Pick<RecordingProxyAddress, "token" | "url">,
): RecordingProxyControl {
  return {
    async startSession(name) {
      await callControl(address, "POST", "session", { name });
    },
    async endSession(passed) {
      return JSON.parse(
        await callControl(address, "POST", "session/end", { passed }),
      ) as { missed: number };
    },
    async stats() {
      return JSON.parse(
        await callControl(address, "GET", "stats"),
      ) as RecordingRunStats;
    },
  };
}

/** Describe the totals of a run in one line. */
export function describeRecordingStats(stats: RecordingRunStats): string {
  const rules = Object.entries(stats.counts)
    .map(
      ([rule, { live, missed, replayed }]) =>
        `${rule} ${replayed} replayed, ${live} live${missed ? `, ${missed} missed` : ""}`,
    )
    .join("; ");
  const passthrough =
    Object.entries(stats.passthrough)
      .map(([origin, count]) => `${origin} ${count}`)
      .join(", ") || "none";
  return `${rules}. ${stats.written} recordings new or changed, ${stats.discarded} dropped from failed sessions. Not recorded: ${passthrough}.`;
}

/**
 * Describe each request that had no recording, one line each. The first
 * miss of a test is the one to fix. Each later miss of the test usually
 * follows from it, because the live response differs from the recording.
 */
export function describeRecordingMisses(misses: RecordingMiss[]): string[] {
  const seen = new Set<string | undefined>();
  return misses
    .filter((miss) => {
      const first = !seen.has(miss.session);
      seen.add(miss.session);
      return first;
    })
    .map((miss) => {
      const where = miss.session ?? "outside a test";
      const why = miss.closest
        ? `differs from ${miss.closest} at ${describeParts(miss.differs)}`
        : "no recording to compare";
      return `${where}: ${miss.rule} ${miss.file} ${why}`;
    });
}

/**
 * Start the proxy in its own process.
 *
 * `launcher` is a command prefix that runs the proxy, such as `sudo`. Use it
 * when the caller cannot reach the network, but the proxy must. `noProxy`
 * lists the hosts that do not use the proxy, such as `localhost`.
 */
export async function spawnRecordingProxy(
  config: RecordingProxyConfig,
  {
    launcher = [],
    noProxy = "localhost,127.0.0.1,::1",
  }: { launcher?: string[]; noProxy?: string } = {},
): Promise<RecordingProxy> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "recording-proxy-client-"));
  const configFile = path.join(tempDir, "config.json");
  await writeFile(configFile, JSON.stringify(config));
  const command = [
    ...launcher,
    process.execPath,
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    SERVER,
    configFile,
  ];
  const child = spawn(command[0]!, command.slice(1), {
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => !PROXY_VARIABLES.has(name.toLowerCase()),
      ),
    ),
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  let address: RecordingProxyAddress;
  try {
    address = await new Promise<RecordingProxyAddress>((resolve, reject) => {
      let output = "";
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(new Error(`Recording proxy exited with code ${code}`)),
      );
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const end = output.indexOf("\n");
        if (end >= 0) resolve(JSON.parse(output.slice(0, end)));
      });
    });
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true });
    throw error;
  }
  const caFile = path.join(tempDir, "ca.pem");
  await writeFile(caFile, address.caCert);

  return {
    ...address,
    ...connectRecordingProxy(address),
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
      await rm(tempDir, { force: true, recursive: true });
    },
  };
}
