import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { zodTool } from "@/chat/tools/definition";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

describe("zodTool", () => {
  it("projects Zod input schemas to JSON Schema and parses tool arguments", async () => {
    const execute = vi.fn(async (input: { count: number }) => input.count);
    const tool = zodTool({
      description: "Count things.",
      inputSchema: z.object({
        count: z.coerce.number().int(),
      }),
      execute,
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
      execute: async () => ({ ok: true }),
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
      execute: async () => ({ ok: true }),
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
      outputSchema: z.object({ ok: z.literal(true) }),
      execute: async () => ({ ok: false }) as never,
    });

    const parsed = tool.prepareArguments!({ value: "test" });
    await expect(tool.execute?.(parsed, {})).rejects.not.toThrow(
      ToolInputError,
    );
  });

  it("rejects parser schemas that cannot be represented as JSON Schema", () => {
    expect(() =>
      zodTool({
        description: "Transform input.",
        inputSchema: z.object({
          value: z.string().transform((value) => value.trim()),
        }),
        execute: async () => ({ ok: true }),
      }),
    ).toThrow("zodTool() inputSchema must be representable as JSON Schema.");
  });
});
