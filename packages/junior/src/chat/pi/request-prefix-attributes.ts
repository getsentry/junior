import { createHash } from "node:crypto";
import type { Tool } from "@earendil-works/pi-ai";

// The provider caches a request prefix in the order tools, system prompt,
// messages. These hashes show on a `gen_ai.chat` span whether that prefix
// changed between two calls, without the prompt or tool text.

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

// Hash only the tool fields that the provider request reads. Runtime-only
// fields, such as `execute` or `label`, do not reach the model. Keep key
// order: the request body keeps it too, so a key-order change does change the
// cached prefix.
function serializeTools(tools: readonly Tool[]): string {
  return JSON.stringify(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.constrainedSampling === undefined
        ? undefined
        : { constrainedSampling: tool.constrainedSampling }),
    })),
  );
}

/**
 * Hashes of the system prompt and the model-facing tool list of one model
 * request, to tell a changed cache prefix apart from an expired cache. Pass
 * `tools` only when the request can send tools.
 */
export function requestPrefixAttributes(
  systemPrompt: string | undefined,
  tools?: readonly Tool[],
): Record<string, string | number> {
  return {
    ...(systemPrompt
      ? { "app.ai.request.system_instructions.hash": shortHash(systemPrompt) }
      : undefined),
    ...(tools
      ? {
          "app.ai.request.tools.count": tools.length,
          "app.ai.request.tools.hash": shortHash(serializeTools(tools)),
        }
      : undefined),
  };
}
