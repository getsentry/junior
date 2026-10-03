import { setTimeout } from "node:timers/promises";
import {
  defineJuniorPlugin,
  definePluginTool,
  type PluginMcp,
  type PluginMcpToolSuccess,
  type PluginRegistration,
  type PluginToolContent,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const POLLS_PER_CALL = 5;
const DEFAULT_WAIT_MS = 20_000;
const inputSchema = z.object({ threadId: z.string().min(1).max(256) }).strict();
const outputSchema = z
  .object({
    threadId: z.string(),
    polls: z.number().int().positive(),
    status: z.enum([
      "complete",
      "pending",
      "unknown",
      "error",
      "authorization_pending",
    ]),
  })
  .strict();

function statusFrom(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  if ("status" in value && typeof value.status === "string") {
    return value.status.toUpperCase();
  }
  if ("thread" in value && value.thread && typeof value.thread === "object") {
    return statusFrom(value.thread);
  }
  return undefined;
}

function threadStatus(result: PluginMcpToolSuccess): string | undefined {
  const structured = statusFrom(result.structuredContent);
  if (structured) return structured;
  for (const part of result.content) {
    if (part.type !== "text") continue;
    try {
      const parsed = statusFrom(JSON.parse(part.text));
      if (parsed) return parsed;
    } catch {
      // Hex also sends plain-text Thread updates.
    }
    const status = part.text.match(
      /^(?:thread\s+)?status:\s*([a-z_]+)\s*$/im,
    )?.[1];
    if (status) return status.toUpperCase();
  }
  return undefined;
}

function waitMs(result: PluginMcpToolSuccess): number {
  const content = result.structuredContent;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    if (
      "waitTime" in content &&
      typeof content.waitTime === "number" &&
      Number.isFinite(content.waitTime)
    ) {
      return Math.max(
        1_000,
        Math.min(content.waitTime * 1_000, DEFAULT_WAIT_MS),
      );
    }
  }
  return DEFAULT_WAIT_MS;
}

function reply(
  threadId: string,
  polls: number,
  status: z.output<typeof outputSchema>["status"],
  content: PluginToolContent[] = [],
) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Hex Thread ${threadId}: ${status} after ${polls} poll(s).`,
      },
      ...content,
    ],
    details: { threadId, polls, status },
  };
}

async function waitForThread(
  mcp: PluginMcp,
  threadId: string,
  signal?: AbortSignal,
) {
  for (const poll of Array.from({ length: POLLS_PER_CALL }, (_, i) => i + 1)) {
    signal?.throwIfAborted();
    const result = await mcp.callTool({
      name: "get_thread",
      arguments: { thread_id: threadId },
    });
    if (result.status === "authorization_pending") {
      return reply(threadId, poll, "authorization_pending");
    }
    if (result.status === "error") return reply(threadId, poll, "error");
    const status = threadStatus(result);
    if (status === "IDLE")
      return reply(threadId, poll, "complete", result.content);
    if (
      status !== "RUNNING" &&
      status !== "PENDING" &&
      status !== "PROCESSING"
    ) {
      return reply(threadId, poll, "unknown", result.content);
    }
    if (poll === POLLS_PER_CALL) return reply(threadId, poll, "pending");
    await setTimeout(waitMs(result), undefined, { signal });
  }
  throw new Error("Hex poll limit was not applied");
}

/** Register Hex Thread tools with one bounded wait per model call. */
export function hexPlugin(): PluginRegistration {
  return defineJuniorPlugin({
    packageName: "@sentry/junior-hex",
    manifest: {
      name: "hex",
      displayName: "Hex",
      description:
        "Hex analytics platform — run data warehouse queries for customer usage data",
      envVars: { HEX_MCP_URL: { default: "https://app.hex.tech/mcp" } },
      mcp: {
        transport: "http",
        url: "${HEX_MCP_URL}",
        allowedTools: ["create_thread", "continue_thread"],
        wrappedTools: ["get_thread"],
      },
    },
    hooks: {
      tools(ctx) {
        const mcp = ctx.mcp;
        if (!mcp) throw new Error("Hex MCP tool access is unavailable");
        return {
          waitForHexThread: definePluginTool({
            description:
              "Wait for a Hex Thread to finish. Calls get_thread up to five times without another model call. If it returns pending, call once more for up to ten total polls. Use the Thread ID from create_thread or continue_thread.",
            annotations: {
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: true,
              readOnlyHint: true,
            },
            inputSchema,
            outputSchema,
            execute: (input, options) =>
              waitForThread(mcp, input.threadId, options.signal),
          }),
        };
      },
    },
  });
}
