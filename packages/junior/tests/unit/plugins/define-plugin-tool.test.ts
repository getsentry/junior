import { describe, expect, it, vi } from "vitest";
import {
  definePluginTool,
  missingToolAnnotationKeys,
  PluginToolInputError,
  pluginToolOutputSchema,
  toolApprovalModeSchema,
  zodTool,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const countResultSchema = pluginToolOutputSchema.extend({
  count: z.number(),
});

describe("definePluginTool", () => {
  it("preserves approval metadata", () => {
    const tool = definePluginTool({
      approvalMode: "review",
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      describeProposal: ({ query }) => `Search for ${query}.`,
      description: "Schedule a meeting.",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: countResultSchema,
      execute: async () => ({ count: 1 }),
    });

    expect(tool.approvalMode).toBe("review");
    expect(tool.annotations).toEqual({
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    });
    const input = tool.prepareArguments?.({ query: "errors" });
    expect(tool.describeProposal?.(input!)).toBe("Search for errors.");
    expect(toolApprovalModeSchema.safeParse("unexpected").success).toBe(false);
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

    expect(tool.approvalMode).toBe("auto");
    expect(tool.inputSchema).toMatchObject({
      properties: {
        count: { type: "integer" },
      },
      required: ["count"],
      type: "object",
    });

    const parsed = tool.prepareArguments?.({ count: "3" });
    expect(parsed).toEqual({ count: 3 });

    await tool.execute?.(parsed as { count: number }, {});
    expect(execute).toHaveBeenCalledWith({ count: 3 }, {});
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
    const result = await tool.execute?.(input as Record<string, never>, {});

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
    await expect(tool.execute(tool.prepareArguments({}), {})).resolves.toEqual({
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
    await expect(tool.execute(tool.prepareArguments({}), {})).rejects.toThrow(
      "Invalid input: expected number",
    );
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
