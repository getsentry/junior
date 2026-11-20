/**
 * The `fetch` dispatcher of each eval test.
 *
 * `@sentry/roach/vitest/setup` gives each test a new proxy dispatcher. Load
 * this file after it, so this hook runs after the Roach hook and changes
 * the dispatcher of the test:
 *
 * - AI Gateway requests get the eval timeouts (`eval-ai-gateway-dispatcher.ts`).
 * - Clients with their own undici `Agent` use the proxy too
 *   (`proxy-dispatcher.ts`). MSW replaces `fetch` before each test file, so
 *   this runs after it.
 */
import { beforeEach, onTestFinished } from "vitest";
import { installEvalAiGatewayDispatcher } from "./eval-ai-gateway-dispatcher";
import { useGlobalDispatcherForFetch } from "./proxy-dispatcher";

beforeEach(() => {
  useGlobalDispatcherForFetch();
  onTestFinished(installEvalAiGatewayDispatcher());
});
