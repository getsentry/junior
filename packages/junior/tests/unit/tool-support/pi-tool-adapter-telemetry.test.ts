import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "@/chat/tools/definition";

const { endAttributes, startAttributes } = vi.hoisted(() => ({
  endAttributes: { value: {} as Record<string, unknown> },
  startAttributes: { value: {} as Record<string, unknown> },
}));

vi.mock("@/chat/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/logging")>();
  return {
    ...actual,
    logWarn: vi.fn(),
    withSpan: vi.fn(
      async (
        _name: string,
        _op: string,
        _context: unknown,
        callback: (
          setSpanAttributes: (attributes: Record<string, unknown>) => void,
        ) => Promise<unknown>,
        attributes: Record<string, unknown>,
      ) => {
        startAttributes.value = { ...attributes };
        return await callback((nextAttributes) => {
          Object.assign(endAttributes.value, nextAttributes);
        });
      },
    ),
  };
});

import { createPiAgentTools } from "@/chat/tool-support/pi-tool-adapter";

describe("createPiAgentTools telemetry", () => {
  beforeEach(() => {
    startAttributes.value = {};
    endAttributes.value = {};
  });

  it("reports metadata for private tool results without exposing content", async () => {
    const tools: Record<string, AnyToolDefinition> = {
      inspect: {
        description: "Inspect a private value.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({
          ok: true,
          status: "success",
          secret: "private result",
        }),
      },
    };
    const [tool] = createPiAgentTools(
      tools,
      {} as never,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "private",
    );

    await tool!.execute!("call-1", {});

    expect(endAttributes.value["gen_ai.tool.call.result"]).toContain(
      '"type":"object"',
    );
    expect(endAttributes.value["gen_ai.tool.call.result"]).not.toContain(
      "private result",
    );
    expect(endAttributes.value["gen_ai.tool.call.result.keys"]).toContain(
      "secret",
    );
  });
});
