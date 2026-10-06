/**
 * `onProgress` handlers that tests share.
 */
import type { CallOptions } from "./agent";
import type { Input } from "./inputs";

/**
 * Send `inputs` while the first agent model request waits. The product
 * decides whether each input steers the running turn or waits for its own.
 */
export function sendDuringFirstModelRequest(
  inputs: Input[],
): NonNullable<CallOptions["onProgress"]> {
  let sent = false;
  return async (progress, { send }) => {
    if (sent || progress.type !== "model_request") return;
    sent = true;
    for (const input of inputs) {
      await send(input);
    }
  };
}
