/**
 * The recording proxy of one eval invocation.
 *
 * Every eval suite starts the proxy in its global setup with
 * `startRecordingRun()`. It then sends all HTTP traffic of the run through
 * the proxy: the main process, the test workers, and their child processes.
 * The workers and child processes read the standard proxy variables, which
 * they inherit. Each test opens its own session with `installRecordings()`
 * (`src/fixture/recordings.ts`). In CI, `scripts/network-jail.sh` also
 * blocks every connection that does not use the proxy. At the end of the run,
 * this module prints the replayed and live counts and how many recordings
 * the run wrote. In GitHub Actions it also adds them to the job summary, so
 * each eval job shows whether recording works.
 */
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  request,
  setGlobalDispatcher,
} from "undici";
import "./eval-context";
import {
  spawnRecordingProxy,
  type RecordingProxy,
  type RecordingRunStats,
} from "./recording-proxy/recording-proxy";
import { NO_PROXY, recordingProxyConfig } from "./recording-rules";
import type { ProvidedContext } from "vitest";

interface RecordingProject {
  provide(
    key: "recordingProxy",
    value: NonNullable<ProvidedContext["recordingProxy"]>,
  ): void;
}

/** Describe the stats of a run in one line. */
function describeRecordingRun(stats: RecordingRunStats): string {
  const rules = Object.entries(stats.counts)
    .map(
      ([rule, { live, replayed }]) =>
        `${rule} ${replayed} replayed, ${live} live`,
    )
    .join("; ");
  const passthrough =
    Object.entries(stats.passthrough)
      .map(([origin, count]) => `${origin} ${count}`)
      .join(", ") || "none";
  return `${rules}. ${stats.written} recordings new or changed, ${stats.discarded} dropped from failed tests. Not recorded: ${passthrough}.`;
}

/** The proxy variables that every process of the run reads. */
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
] as const;

/**
 * The command that starts the proxy. In CI, the proxy must start outside
 * the network jail, because only the proxy can reach upstream origins.
 */
function proxyLauncher(): string[] {
  const value = process.env.EVAL_RECORDING_PROXY_LAUNCHER?.trim();
  return value ? (JSON.parse(value) as string[]) : [];
}

/**
 * Create a `fetch` dispatcher that sends requests through the proxy, in the
 * given session or without one.
 *
 * Use it instead of the proxy variables for `fetch`. undici drops proxy
 * credentials without a user name, so with the variables alone the proxy
 * refuses requests without a session with HTTP 407.
 */
export function createProxyDispatcher(
  proxy: Pick<RecordingProxy, "caCert" | "secret" | "url">,
  session = "",
): EnvHttpProxyAgent {
  const credentials = `${encodeURIComponent(session)}:${proxy.secret}`;
  return new EnvHttpProxyAgent({
    httpProxy: proxy.url,
    httpsProxy: proxy.url,
    noProxy: NO_PROXY,
    token: `Basic ${Buffer.from(credentials).toString("base64")}`,
    requestTls: { ca: proxy.caCert },
  });
}

/**
 * Send all HTTP traffic of this process and of the processes it starts
 * through the proxy. Returns a function that undoes it.
 */
async function routeTrafficThroughProxy(
  proxy: RecordingProxy,
): Promise<() => Promise<void>> {
  const caDir = await mkdtemp(path.join(tmpdir(), "recording-proxy-ca-"));
  const caFile = path.join(caDir, "ca.pem");
  await writeFile(caFile, proxy.caCert);
  const proxyUrl = new URL(proxy.url);
  proxyUrl.password = proxy.secret;
  const previousEnv = PROXY_ENV_KEYS.map((key) => [key, process.env[key]]);
  const proxyEnv = {
    HTTP_PROXY: proxyUrl.href,
    HTTPS_PROXY: proxyUrl.href,
    NO_PROXY,
  };
  // Test workers and child processes start after this and inherit these.
  // Node reads `NODE_USE_ENV_PROXY` and `NODE_EXTRA_CA_CERTS` at startup.
  Object.assign(process.env, proxyEnv, {
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: caFile,
  });

  // This process started before the variables, so set its agents here.
  const previousDispatcher = getGlobalDispatcher();
  const dispatcher = createProxyDispatcher(proxy);
  setGlobalDispatcher(dispatcher);
  const previousAgents = [http.globalAgent, https.globalAgent] as const;
  http.globalAgent = new http.Agent({ proxyEnv });
  https.globalAgent = new https.Agent({ ca: proxy.caCert, proxyEnv });

  return async () => {
    [http.globalAgent, https.globalAgent] = previousAgents;
    setGlobalDispatcher(previousDispatcher);
    await dispatcher.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    await rm(caDir, { force: true, recursive: true });
  };
}

/**
 * Start the recording proxy for this invocation and give its address to the
 * test workers. Returns the teardown, which reports the run and stops the
 * proxy.
 */
export async function startRecordingRun(
  project: RecordingProject,
): Promise<() => Promise<void>> {
  // The proxy runs in its own process, so in-process mocks cannot answer it.
  const proxy = await spawnRecordingProxy(recordingProxyConfig(), {
    launcher: proxyLauncher(),
  });
  const unroute = await routeTrafficThroughProxy(proxy);
  project.provide("recordingProxy", {
    caCert: proxy.caCert,
    secret: proxy.secret,
    url: proxy.url,
  });

  return async () => {
    // The control API is on the proxy itself, so it must not use a proxy.
    const control = new Agent();
    try {
      const response = await request(`${proxy.url}/__recording-proxy/stats`, {
        dispatcher: control,
        headers: { authorization: `Bearer ${proxy.secret}` },
      });
      const line = describeRecordingRun(
        (await response.body.json()) as RecordingRunStats,
      );
      process.stdout.write(`[evals] Recordings: ${line}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `### Eval recordings\n\n${line}\n\n`,
        );
      }
    } finally {
      await control.close();
      await unroute();
      await proxy.close();
    }
  };
}
