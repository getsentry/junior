import { installEvalAiGatewayDispatcher } from "./src/eval-ai-gateway-dispatcher";
import { startRecordingRun } from "./src/recording-run";

/**
 * Set up the lightweight Guardian eval invocation.
 *
 * Guardian cases only need AI Gateway access through Roach.
 * They intentionally skip Postgres, Redis fixtures, MSW, plugin catalogs, and
 * sandbox egress.
 */
export default async function setup(
  project: Parameters<typeof startRecordingRun>[0],
): Promise<() => Promise<void>> {
  const restoreAiGatewayDispatcher = installEvalAiGatewayDispatcher();
  const stopRecordings = await startRecordingRun(project);
  process.stdout.write(
    "[evals:guardian] AI Gateway dispatcher ready (no sandbox egress)\n",
  );
  return async () => {
    try {
      await stopRecordings();
    } finally {
      await restoreAiGatewayDispatcher();
    }
  };
}
