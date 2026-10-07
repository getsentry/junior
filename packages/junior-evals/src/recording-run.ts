/**
 * The recording proxy of one eval invocation.
 *
 * Every eval suite starts the proxy in its global setup with
 * `startRecordingRun()`. Each test then opens its own session with
 * `installRecordings()` (`src/fixture/recordings.ts`). At the end of the run,
 * this module prints the replayed and live counts and how many recordings
 * the run wrote. In GitHub Actions it also adds them to the job summary, so
 * each eval job shows whether recording works.
 */
import { appendFile } from "node:fs/promises";
import { Agent, request } from "undici";
import "./eval-context";
import {
  spawnRecordingProxy,
  type RecordingRunStats,
} from "./recording-proxy/recording-proxy";
import { recordingProxyConfig } from "./recording-rules";

interface RecordingProject {
  provide(
    key: "recordingProxy",
    value: { caCert: string; secret: string; url: string },
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

/**
 * Start the recording proxy for this invocation and give its address to the
 * test workers. Returns the teardown, which reports the run and stops the
 * proxy.
 */
export async function startRecordingRun(
  project: RecordingProject,
): Promise<() => Promise<void>> {
  // The proxy runs in its own process, so in-process mocks cannot answer it.
  const proxy = await spawnRecordingProxy(recordingProxyConfig());
  project.provide("recordingProxy", {
    caCert: proxy.caCert,
    secret: proxy.secret,
    url: proxy.url,
  });

  return async () => {
    try {
      // The control API is on the proxy itself, so it must not use a proxy.
      const control = new Agent();
      try {
        const response = await request(`${proxy.url}/__recording-proxy/stats`, {
          dispatcher: control,
          headers: { authorization: `Bearer ${proxy.secret}` },
        });
        const stats = (await response.body.json()) as RecordingRunStats;
        const line = describeRecordingRun(stats);
        process.stdout.write(`[evals] Recordings: ${line}\n`);
        if (process.env.GITHUB_STEP_SUMMARY) {
          await appendFile(
            process.env.GITHUB_STEP_SUMMARY,
            `### Eval recordings\n\n${line}\n\n`,
          );
        }
      } finally {
        await control.close();
      }
    } finally {
      await proxy.close();
    }
  };
}
