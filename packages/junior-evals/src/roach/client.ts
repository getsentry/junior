/**
 * The client of the Roach service. See `README.md` in this directory.
 *
 * `startRemoteRun()` starts a run on a Roach service. It
 * returns `env`, the variables that send the traffic of a process through
 * the run. `connectRoach()` controls a run from another process, such as a
 * test worker.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RecordingStats, RemoteRun, RunConfig } from "./types.ts";

/** The path of the control API of the service. */
const CONTROL_PATH = "/__roach";

/** The open session of one test. */
export interface RecordingSession {
  /**
   * End the session. A passed session writes its new recordings, and a
   * failed one drops them. `missed` counts the requests of the session that
   * `replay` mode failed. A test with a miss must fail.
   */
  end(passed: boolean): Promise<{ missed: number }>;
}

/** The control API of a run. */
export interface RoachControl {
  /** Open the session of one test. Only one session is open at a time. */
  startSession(name: string): Promise<RecordingSession>;
  /** The totals of the run. */
  stats(): Promise<RecordingStats>;
}

/**
 * Call the control API at `base`, and return the JSON of the response.
 * `token` is the bearer token.
 */
function callControl<T>(
  base: string,
  token: string | undefined,
  method: "DELETE" | "GET" | "POST",
  route: string,
  body?: unknown,
): Promise<T> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const url = route ? `${base}/${route}` : base;
  const client = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        // Its own agent, so that a proxy agent of the process is not used.
        agent: false,
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
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

/** Control a run, for example from a test worker. */
export function connectRoach({
  controlUrl,
  token,
}: Pick<RemoteRun, "controlUrl" | "token">): RoachControl {
  return {
    async startSession(name) {
      await callControl(controlUrl, token, "POST", "session", { name });
      return {
        end: (passed) =>
          callControl(controlUrl, token, "POST", "session/end", {
            name,
            passed,
          }),
      };
    },
    stats: () => callControl(controlUrl, token, "GET", "stats"),
  };
}

/** A run on a Roach service. */
export interface RemoteRoach extends RemoteRun, RoachControl {
  /**
   * The variables that send the HTTP traffic of a process through the run:
   * `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`, and
   * `NODE_EXTRA_CA_CERTS`. Give them to a process when it starts. Node
   * reads the last two only at startup.
   */
  env: Record<string, string>;
  /** End the run. Returns its stats. */
  close(): Promise<RecordingStats>;
}

/**
 * Start a run on a Roach service, such as `https://roach.example.com`.
 *
 * `token` is the write token of the service. Only this call uses it. Without it,
 * the service only allows `replay` mode, so CI jobs of forks can replay
 * without a secret. The run and its workers use the run token.
 */
export async function startRemoteRun(
  service: { url: string; token?: string | undefined },
  config: RunConfig,
  { noProxy = "localhost,127.0.0.1,::1" }: { noProxy?: string } = {},
): Promise<RemoteRoach> {
  const run = await callControl<RemoteRun>(
    `${service.url.replace(/\/$/, "")}${CONTROL_PATH}`,
    service.token,
    "POST",
    "runs",
    config,
  );
  const proxyEnv = await createProxyEnv(run, noProxy).catch(async (error) => {
    // End the run, or it stays open until the service times it out.
    await callControl(run.controlUrl, run.token, "DELETE", "").catch(() => {});
    throw error;
  });
  return {
    ...run,
    ...connectRoach(run),
    env: proxyEnv.env,
    async close() {
      try {
        return await callControl<RecordingStats>(
          run.controlUrl,
          run.token,
          "DELETE",
          "",
        );
      } finally {
        await proxyEnv.remove();
      }
    },
  };
}

/**
 * The proxy variables of a process, with the CA certificate in a file. The
 * file also has the certificates of `NODE_EXTRA_CA_CERTS` of this process,
 * so the process still trusts them.
 */
async function createProxyEnv(
  address: Pick<RemoteRun, "caCert" | "url">,
  noProxy: string,
): Promise<{ env: Record<string, string>; remove(): Promise<void> }> {
  // `NODE_EXTRA_CA_CERTS` takes a file.
  const caDirectory = await mkdtemp(path.join(tmpdir(), "roach-"));
  const caFile = path.join(caDirectory, "ca.pem");
  const extra = process.env.NODE_EXTRA_CA_CERTS;
  await writeFile(
    caFile,
    extra
      ? `${address.caCert.trimEnd()}\n${await readFile(extra, "utf8")}`
      : address.caCert,
  );
  return {
    env: {
      HTTP_PROXY: address.url,
      HTTPS_PROXY: address.url,
      NO_PROXY: noProxy,
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: caFile,
    },
    remove: () => rm(caDirectory, { force: true, recursive: true }),
  };
}
