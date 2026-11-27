import { describe, expect, it, onTestFinished } from "vitest";
import { getSqlExecutor } from "@/chat/db";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";
import { turnToolHooks } from "@/turn-steps/tool-hooks";
import { setModelReplies } from "../fixtures/ai-emulator";
import { createAssistantMessage } from "../fixtures/model-stream";
import { createTurnHarness } from "../fixtures/turn-harness";
import { sendTool } from "../fixtures/turn-engine";

// Action review of a core Turn's tool calls, through the host's tool hooks.

const EMPTY_INPUT = { type: "object", properties: {} } as const;

describe("core Turn tool review", () => {
  it("does not run a host tool that needs review", async () => {
    // No core Turn tool needs review while core bash skips it
    // (design/guardian.md gaps), so `send` stands in for one.
    const executed: string[] = [];
    const harness = await createTurnHarness({
      tools: async (turn) => ({
        definitions: [
          sendTool(executed),
          { ...sendTool(executed), name: "note" },
        ],
        hooks: turnToolHooks({
          ctx: { executor: getSqlExecutor() },
          turnId: turn.turnId,
          tools: new Map<string, AnyToolDefinition>([
            [
              "send",
              {
                description: "Sends a message.",
                inputSchema: EMPTY_INPUT,
                approvalMode: "review",
              },
            ],
            ["note", { description: "Notes.", inputSchema: EMPTY_INPUT }],
          ]),
          workspace: { writeFiles: async () => {} },
        }),
        close: () => {},
      }),
    });
    onTestFinished(() => harness.close());
    const call = createAssistantMessage({
      type: "toolCalls",
      calls: [
        { name: "send", arguments: {}, id: "call-1" },
        { name: "note", arguments: {}, id: "call-2" },
      ],
    });
    const reply = createAssistantMessage({ type: "text", text: "I can't." });
    await setModelReplies([call, reply]);
    const { turnId } = await harness.send({ text: "Send it." });

    await harness.runUntilIdle();

    await expect(harness.turn(turnId)).resolves.toMatchObject({
      state: "completed",
    });
    expect(executed).toEqual(["call-2"]);
    expect(await harness.history()).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "call-1",
        isError: true,
        content: [
          {
            type: "text",
            text: "Required action review is unavailable; the action was not executed.",
          },
        ],
      }),
    );
  });
});
