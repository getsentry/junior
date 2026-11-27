import { describe, expect, it, vi } from "vitest";
import {
  type DescribeContext,
  definePluginTool,
  missingToolAnnotationKeys,
  PluginToolInputError,
  pluginToolOutputSchema,
  zodTool,
} from "@sentry/junior-plugin-api";
import * as z from "zod";

const countResultSchema = pluginToolOutputSchema.extend({
  count: z.number(),
});

describe("definePluginTool", () => {
  it("preserves approval metadata", async () => {
    const tool = definePluginTool({
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      describe: async ({ query }) => ({
        ref: `search:${query}`,
        audience: "internal",
      }),
      description: "Schedule a meeting.",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: countResultSchema,
      execute: async () => ({ count: 1 }),
    });

    expect(tool.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    });
    const input = tool.prepareArguments?.({ query: "errors" });
    const call = await tool.describe?.(input!, {
      // This describe reads nothing, so no read context is used.
      cache: {} as DescribeContext["cache"],
      egress: {} as DescribeContext["egress"],
      isOwnPullRequest: async () => false,
    });
    expect(call?.ref).toBe("search:errors");
  });

  it("reports missing behavioral annotations", () => {
    expect(
      missingToolAnnotationKeys({
        destructiveHint: false,
        readOnlyHint: true,
      }),
    ).toEqual(["idempotentHint", "openWorldHint"]);
  });

  it("projects Zod input schemas to JSON Schema and parses tool arguments", async () => {
    const execute = vi.fn(async (input: { count: number }) => ({
      count: input.count,
    }));
    const tool = definePluginTool({
      description: "Count things.",
      inputSchema: z.object({
        count: z.coerce.number().int(),
      }),
      outputSchema: countResultSchema,
      execute,
    });

    expect(tool.describe).toBeUndefined();
    expect(tool.inputSchema).toMatchObject({
      properties: {
        count: { type: "integer" },
      },
      required: ["count"],
      type: "object",
    });

    const parsed = tool.prepareArguments?.({ count: "3" });
    expect(parsed).toEqual({ count: 3 });

    const ctx = { conversationId: "local:test" } as never;
    await tool.execute?.(parsed as { count: number }, {}, ctx);
    expect(execute).toHaveBeenCalledWith({ count: 3 }, {}, ctx);
  });

  it("runs custom argument preparation before Zod parsing", () => {
    const tool = definePluginTool({
      description: "Normalize names.",
      inputSchema: z.object({
        name: z.string().min(1),
      }),
      outputSchema: countResultSchema,
      prepareArguments(args) {
        return {
          name: (args as { rawName: string }).rawName.trim(),
        };
      },
      execute: async () => ({ count: 1 }),
    });

    expect(tool.prepareArguments?.({ rawName: " Ada " })).toEqual({
      name: "Ada",
    });
    expect(() => tool.prepareArguments?.({ rawName: " " })).toThrow(
      PluginToolInputError,
    );
    expect(() => tool.prepareArguments?.({ rawName: " " })).toThrow(
      "Invalid tool arguments: name:",
    );
  });

  it("exposes zodTool with typed private trace projection", async () => {
    const tool = zodTool({
      description: "Project plugin result.",
      inputSchema: z.object({}),
      outputSchema: countResultSchema,
      privateTraceResult: (result) => ({ count: result.count }),
      execute: async () => ({
        count: 3,
      }),
    });

    const input = tool.prepareArguments?.({});
    const result = await tool.execute?.(
      input as Record<string, never>,
      {},
      undefined as never,
    );

    expect(tool.privateTraceResult?.(result!)).toEqual({ count: 3 });
  });

  it("preserves standard content envelopes and validates their details", async () => {
    const tool = definePluginTool({
      description: "Return provider content.",
      inputSchema: z.object({}),
      outputSchema: countResultSchema,
      execute: async () => ({
        content: [
          { type: "text" as const, text: "Created LIN-123" },
          {
            type: "image" as const,
            data: "base64-image",
            mimeType: "image/png",
          },
        ],
        details: {
          count: 1,
        },
      }),
    });

    if (!tool.execute || !tool.prepareArguments) {
      throw new Error("Expected an executable plugin tool.");
    }
    await expect(
      tool.execute(tool.prepareArguments({}), {}, undefined as never),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "Created LIN-123" },
        {
          type: "image",
          data: "base64-image",
          mimeType: "image/png",
        },
      ],
      details: {
        count: 1,
      },
    });
  });

  it("rejects invalid content envelope details", async () => {
    const tool = definePluginTool({
      description: "Return invalid provider details.",
      inputSchema: z.object({}),
      outputSchema: countResultSchema,
      execute: async () =>
        ({
          content: [{ type: "text", text: "Created LIN-123" }],
          details: {
            count: "one",
          },
        }) as never,
    });

    if (!tool.execute || !tool.prepareArguments) {
      throw new Error("Expected an executable plugin tool.");
    }
    await expect(
      tool.execute(tool.prepareArguments({}), {}, undefined as never),
    ).rejects.toThrow("Invalid input: expected number");
  });

  it("rejects parser schemas that cannot be represented as JSON Schema", () => {
    expect(() =>
      definePluginTool({
        description: "Transform input.",
        inputSchema: z.object({
          value: z.string().transform((value) => value.trim()),
        }),
        outputSchema: countResultSchema,
        execute: async () => ({ count: 1 }),
      }),
    ).toThrow(
      "definePluginTool() inputSchema must be representable as JSON Schema.",
    );
  });
});
