import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { juniorToolOutputSchema } from "@/chat/tool-support/structured-result";
import { zodTool } from "@/chat/tool-support/zod-tool";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

describe("zodTool", () => {
  it("preserves approval metadata", () => {
    const tool = zodTool({
      approvalMode: "approve",
      annotations: { destructiveHint: true, readOnlyHint: false },
      describeProposal: ({ recordId }) => `Delete record ${recordId}.`,
      description: "Delete a record.",
      inputSchema: z.object({ recordId: z.coerce.string() }),
      outputSchema: juniorToolOutputSchema,
      execute: async () => ({ record_id: "42" }),
    });

    expect(tool.approvalMode).toBe("approve");
    expect(tool.annotations).toEqual({
      destructiveHint: true,
      readOnlyHint: false,
    });
    const input = tool.prepareArguments!({ recordId: 42 });
    expect(tool.describeProposal?.(input)).toBe("Delete record 42.");
  });

  it("projects Zod input schemas to JSON Schema and parses tool arguments", async () => {
    const execute = vi.fn(
      async (input: { count: number }, _options: unknown) => input.count,
    );
    const tool = zodTool({
      description: "Count things.",
      inputSchema: z.object({
        count: z.coerce.number().int(),
      }),
      outputSchema: juniorToolOutputSchema,
      execute: async (input, options) => {
        await execute(input, options);
        return { count: input.count };
      },
    });

    expect(tool.approvalMode).toBeUndefined();
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

  it("preserves a typed private trace result projector", async () => {
    const resultSchema = juniorToolOutputSchema.extend({
      visible: z.string(),
      secret: z.string(),
    });
    const tool = zodTool({
      description: "Return projected details.",
      inputSchema: z.object({}),
      outputSchema: resultSchema,
      privateTraceResult: (result) => ({ visible: result.visible }),
      execute: async () => ({
        visible: "catalog metadata",
        secret: "private value",
      }),
    });

    const result = await tool.execute?.(tool.prepareArguments!({}), {});

    expect(tool.privateTraceResult?.(result)).toEqual({
      visible: "catalog metadata",
    });
  });

  it("converts input parse failures into ToolInputError", () => {
    const tool = zodTool({
      description: "Count things.",
      inputSchema: z.object({
        count: z.coerce.number().int(),
      }),
      outputSchema: juniorToolOutputSchema,
      execute: async () => ({ count: 1 }),
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
      outputSchema: juniorToolOutputSchema,
      execute: async () => ({ name: "Ada" }),
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
      outputSchema: juniorToolOutputSchema.extend({
        count: z.number(),
      }),
      execute: async () => ({ count: "one" }) as never,
    });

    expect(tool.outputSchema).toMatchObject({
      properties: {
        count: expect.any(Object),
      },
      required: ["count"],
      type: "object",
    });
    const parsed = tool.prepareArguments!({ value: "test" });
    await expect(tool.execute?.(parsed, {})).rejects.not.toThrow(
      ToolInputError,
    );
  });

  it("preserves content envelopes and validates their details", async () => {
    const tool = zodTool({
      description: "Return result.",
      inputSchema: z.object({ value: z.string() }),
      outputSchema: juniorToolOutputSchema.extend({
        value: z.string(),
      }),
      execute: async (input) => ({
        content: [{ type: "text" as const, text: `value: ${input.value}` }],
        details: {
          value: input.value,
        },
      }),
    });

    await expect(
      tool.execute?.(tool.prepareArguments!({ value: "hello" }), {}),
    ).resolves.toEqual({
      content: [{ type: "text", text: "value: hello" }],
      details: {
        value: "hello",
      },
    });
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
          details: { value: "hello" },
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
        outputSchema: juniorToolOutputSchema,
        execute: async () => ({ value: "hello" }),
      }),
    ).toThrow("zodTool() inputSchema must be representable as JSON Schema.");
  });
});
