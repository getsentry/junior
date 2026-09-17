import { installEvalAiGatewayDispatcher } from "./src/eval-ai-gateway-dispatcher";

/**
 * Set up the lightweight turn router eval invocation.
 *
 * Router cases only need AI Gateway access. They intentionally skip Postgres,
 * Redis fixtures, MSW, plugin catalogs, and sandbox egress.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const restoreAiGatewayDispatcher = installEvalAiGatewayDispatcher();
  process.stdout.write(
    "[evals:router] AI Gateway dispatcher ready (no sandbox egress)\n",
  );
  return restoreAiGatewayDispatcher;
}
