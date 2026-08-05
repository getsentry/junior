/**
 * Local Pi SDK boundary. All Pi package imports used by chat/pi/client.ts
 * are re-exported here so tests can mock a single Junior-owned path instead
 * of Pi's internal subpath layout, which changes across SDK versions.
 */
export {
  calculateCost,
  completeSimple,
  getEnvApiKey,
  getModel,
  getModels,
  isRetryableAssistantError,
  registerApiProvider,
  type Message,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";

export {
  stream as streamAnthropic,
  streamSimple as streamSimpleAnthropic,
} from "@earendil-works/pi-ai/api/anthropic-messages";
