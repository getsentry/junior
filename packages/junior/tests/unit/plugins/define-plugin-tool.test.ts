import { describe, expect, it, vi } from "vitest";
import {
  definePluginTool,
  PluginToolInputError,
  pluginToolResultSchema,
  toolApprovalModeSchema,
  zodTool,
} from "@sentry/junior-plugin-api";
import { z } from "zod";

const countResultSchema = pluginToolResultSchema.extend({
  ok: z.literal(true),
  status: z.literal("success"),
  count: z.number(),
  data: z.object({ count: z.number() }),
});

describe("definePluginTool", () => {
  it("preserves approval metadata", () => {
    const tool = definePluginTool({
      approvalMode: "review",
      annotations: {
        destructiveHint: false,
        openWorldHint: true,
        readOnlyHint: true,
      },
      describeProposal: ({ query }) => `Search for ${query}.`,
      description: "Schedule a meeting.",
      inputSchema: z.object({ query: z.string() }),
      outputSchema: countResultSchema,
      execute: async () =>
        ({
          ok: true,
          status: "success",
          data: { count: 1 },
          count: 1,
        }) as const,
    });

    expect(tool.approvalMode).toBe("review");
    expect(tool.annotations).toEqual({
      destructiveHint: false,
      openWorldHint: true,
      readOnlyHint: true,
    });
    const input = tool.prepareArguments?.({ query: "errors" });
    expect(tool.describeProposal?.(input!)).toBe("Search for errors.");
    expect(toolApprovalModeSchema.safeParse("unexpected").success).toBe(false);
  });

  it("projects Zod input schemas to JSON Schema and parses tool arguments", async () => {
    const execute = vi.fn(
      async (input: { count: number }) =>
        ({
          ok: true,
          status: "success",
          data: { count: input.count },
          count: input.count,
        }) as const,
    );
    const tool = definePluginTool({
      description: "Count things.",
      inputSchema: z.object({
        count: z.coerce.number().int(),
      }),
      outputSchema: countResultSchema,
      execute,
    });

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
      execute: async () =>
        ({
          ok: true,
          status: "success",
          data: { count: 1 },
          count: 1,
        }) as const,
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
        ok: true as const,
        status: "success" as const,
        count: 3,
        data: { count: 3 },
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
          ok: true as const,
          status: "success" as const,
          count: 1,
          data: { count: 1 },
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
        ok: true,
        status: "success",
        count: 1,
        data: { count: 1 },
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
            ok: true,
            status: "success",
            count: "one",
            data: { count: 1 },
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
        execute: async () =>
          ({
            ok: true,
            status: "success",
            data: { count: 1 },
            count: 1,
          }) as const,
      }),
    ).toThrow(
      "definePluginTool() inputSchema must be representable as JSON Schema.",
    );
  });
});
