import type { PluginContext } from "./context";
import type { EventPublisher } from "./events";

/** Longest delay that a plugin job can ask for. */
export const PLUGIN_JOB_MAX_DELAY_MS = 30 * 60_000;

/** One plugin job to run later. */
export interface PluginJobInput {
  /** Wait this long before the job runs. At most `PLUGIN_JOB_MAX_DELAY_MS`. */
  delayMs: number;
  /**
   * Drop this job when an earlier job has the same name and key. The queue
   * remembers a key for up to an hour, also after the job ran. Put a time
   * bucket in the key to run at most one job per bucket.
   */
  key?: string;
  /** Job name that the plugin registered in `jobs`. */
  name: string;
  /** Data for the job. It must survive JSON. */
  payload: unknown;
}

/** Schedules plugin jobs. Each job runs once, outside any Conversation. */
export interface PluginJobScheduler {
  schedule(job: PluginJobInput): Promise<void>;
}

/** Runtime context passed to a plugin job. */
export interface PluginJobContext extends PluginContext {
  /** Core-owned delivery boundary for provider events. */
  events: EventPublisher;
  /** Schedules more jobs, for example to repeat this one later. */
  jobs: PluginJobScheduler;
  payload: unknown;
}

/** Plugin job handler registered by name. */
export interface PluginJobDefinition {
  /** A thrown error makes the queue deliver the job again. */
  run(ctx: PluginJobContext): Promise<void>;
}

/** Job handlers keyed by the plugin-owned job name. */
export type PluginJobs = Record<string, PluginJobDefinition>;
