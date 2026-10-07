/**
 * The recording proxy of one eval invocation.
 *
 * Every eval suite calls `startRecordingRun()` in its global setup. It starts
 * the proxy (`src/recording-proxy/`) with the rules of
 * `src/recording-rules.ts`, and sends all HTTP traffic of the run through
 * it. The proxy owns all reads and writes of recordings. Test workers and
 * child processes inherit the proxy variables. `src/recording-setup.ts`
 * tells the proxy when each test starts and ends. In CI,
 * `scripts/network-jail.sh` also blocks every connection that does not use
 * the proxy. At the end of the run, this module prints the totals of the
 * proxy. In GitHub Actions it also adds them to the job summary.
 */
import { appendFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import {
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import "./eval-context";
import {
  describeRecordingStats,
  spawnRecordingProxy,
  type RecordingProxyAddress,
} from "./recording-proxy/client";
import { NO_PROXY, recordingProxyConfig } from "./recording-rules";
import type { ProvidedContext } from "vitest";

interface RecordingProject {
  provide(
    key: "recordingProxy",
    value: NonNullable<ProvidedContext["recordingProxy"]>,
  ): void;
}

/**
 * Create a `fetch` dispatcher that sends requests through the proxy.
 *
 * Node 24 reads the proxy variables for `fetch` at startup. A process that
 * started before the variables, or an older Node, needs this dispatcher.
 */
export function createProxyDispatcher(
  proxy: Pick<RecordingProxyAddress, "caCert" | "url">,
): EnvHttpProxyAgent {
  return new EnvHttpProxyAgent({
    httpProxy: proxy.url,
    httpsProxy: proxy.url,
    noProxy: NO_PROXY,
    requestTls: { ca: proxy.caCert },
  });
}

/**
 * The command that starts the proxy. In CI, the proxy must start outside
 * the network jail, because only the proxy can reach upstream origins.
 */
function proxyLauncher(): string[] {
  const value = process.env.EVAL_RECORDING_PROXY_LAUNCHER?.trim();
  return value ? (JSON.parse(value) as string[]) : [];
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
    noProxy: NO_PROXY,
  });
  const previousEnv = Object.keys(proxy.env).map(
    (key) => [key, process.env[key]] as const,
  );
  // Test workers and child processes start after this and inherit these.
  Object.assign(process.env, proxy.env);
  // This process started before the variables, so set its agents here.
  const previousDispatcher = getGlobalDispatcher();
  const dispatcher = createProxyDispatcher(proxy);
  setGlobalDispatcher(dispatcher);
  const previousAgents = [http.globalAgent, https.globalAgent] as const;
  const proxyEnv = {
    HTTP_PROXY: proxy.url,
    HTTPS_PROXY: proxy.url,
    NO_PROXY,
  };
  http.globalAgent = new http.Agent({ proxyEnv });
  https.globalAgent = new https.Agent({ ca: proxy.caCert, proxyEnv });
  project.provide("recordingProxy", {
    caCert: proxy.caCert,
    token: proxy.token,
    url: proxy.url,
  });

  return async () => {
    try {
      const line = describeRecordingStats(await proxy.stats());
      process.stdout.write(`[evals] Recordings: ${line}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `### Eval recordings\n\n${line}\n\n`,
        );
      }
    } finally {
      [http.globalAgent, https.globalAgent] = previousAgents;
      setGlobalDispatcher(previousDispatcher);
      await dispatcher.close();
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await proxy.close();
    }
  };
}
