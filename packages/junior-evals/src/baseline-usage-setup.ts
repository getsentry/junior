// Temporary: records each live AI Gateway call of a Guardian eval for the
// fair baseline. Removed with the workflow change that loads it.
import { appendFileSync } from "node:fs";
import { expect } from "vitest";

const file = process.env["BASELINE_USAGE_FILE"];
const originalFetch = globalThis.fetch;

if (file) {
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("ai-gateway")) return await originalFetch(input, init);
    const started = performance.now();
    const response = await originalFetch(input, init);
    const ms = Math.round(performance.now() - started);
    let usage: unknown;
    let cost: unknown;
    try {
      const body = (await response.clone().json()) as {
        providerMetadata?: { gateway?: { cost?: unknown } };
        usage?: unknown;
      };
      usage = body.usage;
      cost = body.providerMetadata?.gateway?.cost;
    } catch {
      usage = undefined;
    }
    appendFileSync(
      file,
      `${JSON.stringify({
        cost,
        ms,
        status: response.status,
        test: expect.getState().currentTestName,
        usage,
      })}\n`,
    );
    return response;
  };
}
