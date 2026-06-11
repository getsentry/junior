import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantReply } from "@/chat/respond";
import { CHAT_USAGE, runChat } from "@/cli/chat";

const runner = vi.hoisted(() => ({
  runLocalAgentTurn: vi.fn(),
}));

vi.mock("@/chat/local/runner", () => ({
  runLocalAgentTurn: runner.runLocalAgentTurn,
}));

function reply(outcome: AssistantReply["diagnostics"]["outcome"]): {
  conversationId: string;
  reply: AssistantReply;
} {
  return {
    conversationId: "local:test:default",
    reply: {
      text: outcome === "success" ? "hello" : "failed",
      diagnostics: {
        assistantMessageCount: 1,
        modelId: "test",
        outcome,
        toolCalls: [],
        toolErrorCount: 0,
        toolResultCount: 0,
        usedPrimaryText: true,
      },
    } satisfies AssistantReply,
  };
}

describe("chat cli", () => {
  beforeEach(() => {
    runner.runLocalAgentTurn.mockReset();
  });

  it("returns usage for invalid argument forms", async () => {
    const lines: string[] = [];
    const io = {
      error: (line: string) => {
        lines.push(line);
      },
      input: process.stdin,
      output: process.stdout,
      write: () => undefined,
    };

    expect(await runChat(["--conversation"], io)).toBe(1);
    expect(await runChat(["--once"], io)).toBe(1);
    expect(await runChat(["unexpected"], io)).toBe(1);
    expect(await runChat(["--conversation", "../bad"], io)).toBe(1);

    expect(lines).toEqual([CHAT_USAGE, CHAT_USAGE, CHAT_USAGE, CHAT_USAGE]);
  });

  it("returns success for a successful once reply", async () => {
    const output: string[] = [];
    runner.runLocalAgentTurn.mockImplementation(async (_input, deps) => {
      const result = reply("success");
      await deps.deliverReply(result.reply);
      return result;
    });

    const io = {
      error: vi.fn(),
      input: process.stdin,
      output: process.stdout,
      write: async (text: string) => {
        output.push(text);
      },
    };

    expect(await runChat(["--once", "hello"], io)).toBe(0);
    expect(output).toEqual(["hello\n"]);
  });

  it("accepts flag-like tokens as once message text", async () => {
    runner.runLocalAgentTurn.mockImplementation(async (_input, deps) => {
      const result = reply("success");
      await deps.deliverReply(result.reply);
      return result;
    });

    const io = {
      error: vi.fn(),
      input: process.stdin,
      output: process.stdout,
      write: vi.fn(),
    };

    expect(await runChat(["--once", "explain", "--flag"], io)).toBe(0);
    expect(runner.runLocalAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "explain --flag",
      }),
      expect.any(Object),
    );
  });

  it("accepts conversation after the once message", async () => {
    runner.runLocalAgentTurn.mockImplementation(async (_input, deps) => {
      const result = reply("success");
      await deps.deliverReply(result.reply);
      return result;
    });

    const io = {
      error: vi.fn(),
      input: process.stdin,
      output: process.stdout,
      write: vi.fn(),
    };

    expect(
      await runChat(["--once", "hello", "--conversation", "later"], io),
    ).toBe(0);
    expect(runner.runLocalAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.stringMatching(/:later$/),
        message: "hello",
      }),
      expect.any(Object),
    );
  });

  it("returns failure for a failed once reply after delivery", async () => {
    const output: string[] = [];
    runner.runLocalAgentTurn.mockImplementation(async (_input, deps) => {
      const result = reply("provider_error");
      await deps.deliverReply(result.reply);
      return result;
    });

    const io = {
      error: vi.fn(),
      input: process.stdin,
      output: process.stdout,
      write: async (text: string) => {
        output.push(text);
      },
    };

    expect(await runChat(["--once", "hello"], io)).toBe(1);
    expect(output).toEqual(["failed\n"]);
  });

  it("returns failure when once delivery fails", async () => {
    runner.runLocalAgentTurn.mockImplementation(async (_input, deps) => {
      await deps.deliverReply(reply("success").reply);
      return reply("success");
    });

    const io = {
      error: vi.fn(),
      input: process.stdin,
      output: process.stdout,
      write: async () => {
        throw new Error("stdout closed");
      },
    };

    expect(await runChat(["--once", "hello"], io)).toBe(1);
    expect(io.error).toHaveBeenCalledWith("stdout closed");
  });

  it("returns failure when a once reply contains files", async () => {
    runner.runLocalAgentTurn.mockImplementation(async (_input, deps) => {
      const result = reply("success");
      result.reply.files = [
        { data: Buffer.from("report"), filename: "report.txt" },
      ];
      await deps.deliverReply(result.reply);
      return result;
    });

    const io = {
      error: vi.fn(),
      input: process.stdin,
      output: process.stdout,
      write: vi.fn(),
    };

    expect(await runChat(["--once", "hello"], io)).toBe(1);
    expect(io.write).not.toHaveBeenCalled();
    expect(io.error).toHaveBeenCalledWith(
      "Local chat cannot deliver files yet: report.txt",
    );
  });

  it("continues interactive chat after a turn error", async () => {
    const errors: string[] = [];
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    runner.runLocalAgentTurn.mockRejectedValueOnce(new Error("turn failed"));

    const pending = runChat([], {
      error: (line) => {
        errors.push(line);
      },
      input,
      output,
      write: vi.fn(),
    });
    input.write("hello\n");
    await new Promise((resolve) => setImmediate(resolve));
    input.write("/exit\n");
    input.end();

    const code = await pending;
    expect(code).toBe(0);
    expect(errors).toEqual(["turn failed"]);
    expect(runner.runLocalAgentTurn).toHaveBeenCalledTimes(1);
  });
});
