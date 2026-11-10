/** Run one plugin job from the queue. */
import { withSpan } from "@/chat/logging";
import {
  createPluginEventPublisher,
  getPlugins,
  type AppEventPublisher,
} from "./agent-hooks";
import { basePluginContext } from "./hook-context";
import {
  createPluginJobScheduler,
  type PluginJobQueueMessage,
} from "./job-queue";

/** Run one plugin job in a `plugin.job` span. A thrown error retries it. */
export async function runPluginJob(
  message: PluginJobQueueMessage,
  events: AppEventPublisher,
): Promise<void> {
  const plugin = getPlugins().find(
    (candidate) => candidate.manifest.name === message.plugin,
  );
  const job =
    plugin?.jobs && Object.hasOwn(plugin.jobs, message.name)
      ? plugin.jobs[message.name]
      : undefined;
  if (!plugin || !job) {
    throw new Error(
      `Plugin job "${message.plugin}.${message.name}" is not registered`,
    );
  }
  await withSpan(
    `plugin.job ${message.plugin}.${message.name}`,
    "plugin.job",
    {},
    () =>
      job.run({
        ...basePluginContext(plugin),
        events: createPluginEventPublisher(plugin, events),
        jobs: createPluginJobScheduler(plugin),
        payload: JSON.parse(message.payload) as unknown,
      }),
    {
      "app.plugin.job": message.name,
      "app.plugin.name": message.plugin,
    },
  );
}
