import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { juniorToolResultSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

describe("zodTool", () => {
  it("projects Zod input schemas to JSON Schema and parses tool arguments", async () => {
    const execute = vi.fn(
      async (input: { count: number }, _options: unknown) => input.count,
    );
    const tool = zodTool({
      description: "Count things.",
      inputSchema: z.object({
        count: z.coerce.number().int(),
      }),
      outputSchema: juniorToolResultSchema,
      execute: async (input, options) => {
        await execute(input, options);
        return {
          ok: true,
          status: "success" as const,
        };
      },
    });

    expect(tool.inputSchema).toMatchObject({
      properties: {
        count: { type: "integer" },
      },
      required: ["count"],
      type: "object",
    });

    const parsed = tool.prepareArguments!({ count: "3" });
    expect(parsed).toEqual({ count: 3 });

    await tool.execute?.(parsed, {});
    expect(execute).toHaveBeenCalledWith({ count: 3 }, {});
  });

  it("converts input parse failures into ToolInputError", () => {
    const tool = zodTool({
      description: "Count things.",
      inputSchema: z.object({
        count: z.coerce.number().int(),
      }),
      outputSchema: juniorToolResultSchema,
      execute: async () => ({ ok: true, status: "success" as const }),
    });

    expect(() => tool.prepareArguments?.({ count: "nope" })).toThrow(
      ToolInputError,
    );
    expect(() => tool.prepareArguments?.({ count: "nope" })).toThrow(
      "Invalid tool arguments: count:",
    );
  });

  it("runs custom argument preparation before Zod parsing", () => {
    const tool = zodTool({
      description: "Normalize names.",
      inputSchema: z.object({
        name: z.string().min(1),
      }),
      prepareArguments(args) {
        return {
          name: (args as { rawName: string }).rawName.trim(),
        };
      },
      outputSchema: juniorToolResultSchema,
      execute: async () => ({ ok: true, status: "success" as const }),
    });

    expect(tool.prepareArguments?.({ rawName: " Ada " })).toEqual({
      name: "Ada",
    });
    expect(() => tool.prepareArguments?.({ rawName: " " })).toThrow(
      ToolInputError,
    );
  });

  it("validates declared output without classifying failures as tool input errors", async () => {
    const tool = zodTool({
      description: "Return result.",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: juniorToolResultSchema.extend({
        ok: z.literal(true),
        status: z.literal("success"),
      }),
      execute: async () =>
        ({ ok: true, status: "error", error: "wrong status" }) as never,
    });

    expect(tool.outputSchema).toMatchObject({
      properties: {
        ok: expect.any(Object),
        status: expect.any(Object),
      },
      required: ["ok", "status"],
      type: "object",
    });
    const parsed = tool.prepareArguments!({ value: "test" });
    await expect(tool.execute?.(parsed, {})).rejects.not.toThrow(
      ToolInputError,
    );
  });

  it("rejects content envelopes when an output schema is declared", async () => {
    const tool = zodTool({
      description: "Return result.",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: juniorToolResultSchema.extend({
        data: z.object({
          value: z.string(),
        }),
      }),
      execute: async (input) =>
        ({
          content: [{ type: "text" as const, text: `value: ${input.value}` }],
          details: {
            ok: true,
            status: "success" as const,
            data: {
              value: input.value,
            },
          },
        }) as never,
    });

    await expect(
      tool.execute?.(tool.prepareArguments!({ value: "hello" }), {}),
    ).rejects.toThrow("Invalid input: expected boolean");
  });

  it("allows native content tools without a structured output schema", async () => {
    const tool = zodTool({
      description: "Return native content.",
      inputSchema: z.object({ value: z.string() }),
      execute: async (input) => ({
        content: [
          { type: "text" as const, text: input.value },
          {
            type: "image" as const,
            data: "base64-image",
            mimeType: "image/png",
          },
        ],
      }),
    });

    expect(tool.outputSchema).toBeUndefined();
    await expect(
      tool.execute?.(tool.prepareArguments!({ value: "hello" }), {}),
    ).resolves.toEqual({
      content: [
        { type: "text", text: "hello" },
        {
          type: "image",
          data: "base64-image",
          mimeType: "image/png",
        },
      ],
    });
  });

  it("rejects details from native content tools", async () => {
    const tool = zodTool({
      description: "Return native content.",
      inputSchema: z.object({ value: z.string() }),
      execute: async () =>
        ({
          content: [{ type: "text" as const, text: "hello" }],
          details: { ok: true, status: "success" as const },
        }) as never,
    });

    await expect(
      tool.execute?.(tool.prepareArguments!({ value: "x" }), {}),
    ).rejects.toThrow(
      "zodTool() content-only tools must return { content } without details.",
    );
  });

  it("rejects parser schemas that cannot be represented as JSON Schema", () => {
    expect(() =>
      zodTool({
        description: "Transform input.",
        inputSchema: z.object({
          value: z.string().transform((value) => value.trim()),
        }),
        outputSchema: juniorToolResultSchema,
        execute: async () => ({ ok: true, status: "success" as const }),
      }),
    ).toThrow("zodTool() inputSchema must be representable as JSON Schema.");
  });
});
