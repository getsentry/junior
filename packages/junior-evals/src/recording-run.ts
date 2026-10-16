/**
 * Roach run of one eval invocation.
 *
 * Every eval suite calls `startRecordingRun()` in its global setup. It starts
 * a run on Roach, the shared recording service (`src/roach/`), with the
 * rules of `src/recording-rules.ts`, and sends all HTTP traffic of the
 * invocation through it. The service owns all reads and writes of
 * recordings. Test workers and child processes inherit the proxy variables.
 * `src/recording-setup.ts` tells the service when each test starts and
 * ends. In CI, `scripts/network-jail.sh` also blocks every connection that
 * does not use the proxy. At the end of the run, this module prints the
 * totals of the run. In GitHub Actions it also adds them to the job summary.
 */
import { appendFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { rootCertificates } from "node:tls";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import "./eval-context";
import { createProxyDispatcher } from "./proxy-dispatcher";
import { startRemoteRun } from "./roach/client";
import {
  describeRecordingMisses,
  describeRecordingStats,
} from "./roach/report";
import { NO_PROXY, ROACH_URL, roachRunConfig } from "./recording-rules";
import type { ProvidedContext } from "vitest";

interface RecordingProject {
  provide(key: "roach", value: NonNullable<ProvidedContext["roach"]>): void;
}

/**
 * Start a Roach run for this invocation and give its address to the test
 * workers. Returns the teardown, which ends the run and reports it.
 */
export async function startRecordingRun(
  project: RecordingProject,
): Promise<() => Promise<void>> {
  // The write token allows `auto` and `record` mode. Only this call uses it,
  // so test workers and child processes do not get it.
  const token = process.env.ROACH_TOKEN?.trim() || undefined;
  delete process.env.ROACH_TOKEN;
  const run = await startRemoteRun(
    { url: ROACH_URL, token },
    roachRunConfig(token !== undefined),
    { noProxy: NO_PROXY },
  );
  // The proxy URL has the run token. Keep it out of the CI log.
  if (process.env.GITHUB_ACTIONS) {
    process.stdout.write(`::add-mask::${run.token}\n`);
  }
  const previousEnv = Object.keys(run.env).map(
    (key) => [key, process.env[key]] as const,
  );
  // Test workers and child processes start after this and inherit these.
  Object.assign(process.env, run.env);
  // This process started before the variables, so set its agents here.
  const previousDispatcher = getGlobalDispatcher();
  const dispatcher = createProxyDispatcher(run);
  setGlobalDispatcher(dispatcher);
  const previousAgents = [http.globalAgent, https.globalAgent] as const;
  http.globalAgent = new http.Agent({ proxyEnv: run.env });
  https.globalAgent = new https.Agent({
    // The proxy has a public certificate. The hosts behind it have
    // certificates of the Roach certificate authority.
    ca: [...rootCertificates, run.caCert],
    proxyEnv: run.env,
  });
  project.provide("roach", {
    caCert: run.caCert,
    controlUrl: run.controlUrl,
    token: run.token,
    url: run.url,
  });

  return async () => {
    try {
      const stats = await run.close();
      const line = describeRecordingStats(stats);
      const misses = describeRecordingMisses(stats.misses);
      process.stdout.write(
        `[evals] Recordings: ${line}\n${misses.map((miss) => `[evals] No recording: ${miss}\n`).join("")}`,
      );
      if (process.env.GITHUB_STEP_SUMMARY) {
        const list = misses.length
          ? `\n\nFirst request without a recording, per test:\n\n${misses.map((miss) => `- ${miss}`).join("\n")}`
          : "";
        await appendFile(
          process.env.GITHUB_STEP_SUMMARY,
          `### Eval recordings\n\n${line}${list}\n\n`,
        );
      }
      // A failed test already fails the run. A miss outside a test, such as
      // in global setup, must fail it too. A teardown error does not.
      const missed = Object.values(stats.counts).reduce(
        (total, count) => total + count.missed,
        0,
      );
      if (missed > 0) process.exitCode = 1;
    } finally {
      [http.globalAgent, https.globalAgent] = previousAgents;
      setGlobalDispatcher(previousDispatcher);
      await dispatcher.close();
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}
