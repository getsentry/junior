import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_USAGE, runChat } from "@/cli/chat";
import type {
  LocalAgentReply,
  LocalAgentTurnResult,
} from "@/chat/local/runner";

const runner = vi.hoisted(() => ({
  runLocalAgentTurn: vi.fn(),
}));

vi.mock("@/chat/local/runner", () => ({
  runLocalAgentTurn: runner.runLocalAgentTurn,
}));

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;

function reply(outcome: LocalAgentTurnResult["outcome"]): {
  conversationId: string;
  outcome: LocalAgentTurnResult["outcome"];
  reply: LocalAgentReply;
} {
  return {
    conversationId: "local:test:run-test",
    outcome,
    reply: {
      text: outcome === "success" ? "hello" : "failed",
    },
  };
}

describe("chat cli", () => {
  beforeEach(() => {
    runner.runLocalAgentTurn.mockReset();
  });

  afterEach(() => {
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_STATE_ADAPTER);
    restoreEnv("REDIS_URL", ORIGINAL_REDIS_URL);
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

    expect(await runChat(["--once"], io)).toBe(1);
    expect(await runChat(["--conversation"], io)).toBe(1);
    expect(await runChat(["-p"], io)).toBe(1);
    expect(await runChat(["unexpected"], io)).toBe(1);

    expect(lines).toEqual([CHAT_USAGE, CHAT_USAGE, CHAT_USAGE, CHAT_USAGE]);
  });

  it("returns success for a successful prompt reply", async () => {
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

    expect(await runChat(["-p", "hello"], io)).toBe(0);
    expect(output).toEqual(["hello\n"]);
    expect(runner.runLocalAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.stringMatching(/:run-[a-f0-9-]+$/),
        message: "hello",
      }),
      expect.any(Object),
    );
  });

  it("defaults prompt local chat to memory even when REDIS_URL is present", async () => {
    delete process.env.JUNIOR_STATE_ADAPTER;
    process.env.REDIS_URL = "redis://localhost:6379";
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

    expect(await runChat(["-p", "hello"], io)).toBe(0);
    expect(process.env.JUNIOR_STATE_ADAPTER).toBe("memory");
  });

  it("preserves an explicit prompt local chat state adapter", async () => {
    process.env.JUNIOR_STATE_ADAPTER = "redis";
    process.env.REDIS_URL = "redis://localhost:6379";
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

    expect(await runChat(["-p", "hello"], io)).toBe(0);
    expect(process.env.JUNIOR_STATE_ADAPTER).toBe("redis");
  });

  it("defaults interactive local chat to memory even when REDIS_URL is present", async () => {
    delete process.env.JUNIOR_STATE_ADAPTER;
    process.env.REDIS_URL = "redis://localhost:6379";
    const input = new PassThrough();
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const pending = runChat([], {
      error: vi.fn(),
      input,
      output,
      write: vi.fn(),
    });
    input.write("/exit\n");
    input.end();

    expect(await pending).toBe(0);
    expect(process.env.JUNIOR_STATE_ADAPTER).toBe("memory");
  });

  it("uses a fresh local conversation for each prompt invocation", async () => {
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

    expect(await runChat(["-p", "first"], io)).toBe(0);
    expect(await runChat(["-p", "second"], io)).toBe(0);

    const firstConversationId =
      runner.runLocalAgentTurn.mock.calls[0]?.[0].conversationId;
    const secondConversationId =
      runner.runLocalAgentTurn.mock.calls[1]?.[0].conversationId;
    expect(firstConversationId).toMatch(/:run-[a-f0-9-]+$/);
    expect(secondConversationId).toMatch(/:run-[a-f0-9-]+$/);
    expect(secondConversationId).not.toBe(firstConversationId);
  });

  it("accepts flag-like tokens as prompt message text", async () => {
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

    expect(await runChat(["-p", "explain", "--flag"], io)).toBe(0);
    expect(runner.runLocalAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "explain --flag",
      }),
      expect.any(Object),
    );
  });

  it("returns failure for a failed prompt reply after delivery", async () => {
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

    expect(await runChat(["-p", "hello"], io)).toBe(1);
    expect(output).toEqual(["failed\n"]);
  });

  it("returns failure when prompt delivery fails", async () => {
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

    expect(await runChat(["-p", "hello"], io)).toBe(1);
    expect(io.error).toHaveBeenCalledWith("stdout closed");
  });

  it("returns failure when a prompt reply contains files", async () => {
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

    expect(await runChat(["-p", "hello"], io)).toBe(1);
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
    runner.runLocalAgentTurn.mockResolvedValueOnce(reply("success"));

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
    input.write("again\n");
    await new Promise((resolve) => setImmediate(resolve));
    input.write("/exit\n");
    input.end();

    const code = await pending;
    expect(code).toBe(0);
    expect(errors).toEqual(["turn failed"]);
    expect(runner.runLocalAgentTurn).toHaveBeenCalledTimes(2);
    const firstConversationId =
      runner.runLocalAgentTurn.mock.calls[0]?.[0].conversationId;
    const secondConversationId =
      runner.runLocalAgentTurn.mock.calls[1]?.[0].conversationId;
    expect(firstConversationId).toMatch(/:run-[a-f0-9-]+$/);
    expect(secondConversationId).toBe(firstConversationId);
    expect(runner.runLocalAgentTurn.mock.calls[0]?.[0].message).toBe("hello");
    expect(runner.runLocalAgentTurn.mock.calls[1]?.[0].message).toBe("again");
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
