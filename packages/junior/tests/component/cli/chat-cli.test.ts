import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_USAGE, runChat } from "@/cli/chat";
import type {
  LocalAgentReply,
  LocalAgentTurnResult,
} from "@/chat/local/runner";

const runner = vi.hoisted(() => ({
  runLocalAgentTurn: vi.fn(),
}));
const testDb = vi.hoisted(() => ({
  requiredDatabaseConnection: true,
}));
const db = vi.hoisted(() => ({
  getDb: vi.fn(() => testDb),
}));

vi.mock("@/chat/local/runner", () => ({
  runLocalAgentTurn: runner.runLocalAgentTurn,
}));

vi.mock("@/chat/db", () => ({
  getDb: db.getDb,
}));

const ORIGINAL_STATE_ADAPTER = process.env.JUNIOR_STATE_ADAPTER;
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_CWD = process.cwd();

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

async function waitForMockCalls(
  mock: { mock: { calls: unknown[] } },
  count: number,
): Promise<void> {
  // Deadline-based rather than iteration-bounded: under coverage runs with
  // saturated workers, a fixed number of event-loop turns is not enough for
  // the readline loop to consume stdin.
  const deadlineMs = Date.now() + 10_000;
  while (Date.now() < deadlineMs) {
    if (mock.mock.calls.length >= count) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Expected ${count} mock calls`);
}

describe("chat cli", () => {
  beforeEach(() => {
    runner.runLocalAgentTurn.mockReset();
    db.getDb.mockReset();
    db.getDb.mockImplementation(() => testDb);
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_STATE_ADAPTER);
    restoreEnv("REDIS_URL", ORIGINAL_REDIS_URL);
    restoreEnv("DATABASE_URL", ORIGINAL_DATABASE_URL);
    vi.resetModules();
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

  it("prints tool results on the status stream after execution", async () => {
    const output: string[] = [];
    const status: string[] = [];
    runner.runLocalAgentTurn.mockImplementation(async (_input, deps) => {
      const result = reply("success");
      await deps.onToolResult?.({
        ok: true,
        toolName: "createMemory",
        params: { content: "remember this" },
        result: { ok: true, created: true },
      });
      await deps.onToolResult?.({
        ok: false,
        toolName: "searchMemories",
        params: { query: "remember" },
        error: "Search failed",
      });
      await deps.deliverReply(result.reply);
      return result;
    });

    const io = {
      error: (line: string) => {
        status.push(line);
      },
      input: process.stdin,
      output: process.stdout,
      write: async (text: string) => {
        output.push(text);
      },
    };

    expect(await runChat(["-p", "hello"], io)).toBe(0);
    expect(status).toEqual([
      'tool: createMemory ok {"ok":true,"created":true}',
      "tool: searchMemories error Search failed",
    ]);
    expect(output).toEqual(["hello\n"]);
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
    const { getChatConfig } = await import("@/chat/config");
    expect(getChatConfig().state.adapter).toBe("memory");
  });

  it("fails local chat for hook plugins when database access fails", async () => {
    delete process.env.DATABASE_URL;
    db.getDb.mockImplementationOnce(() => {
      throw new Error("DATABASE_URL is required");
    });
    const tempDir = mkdtempSync(path.join(tmpdir(), "junior-chat-plugins-"));
    writeFileSync(
      path.join(tempDir, "plugins.mjs"),
      `export const plugins = {
  packageNames: [],
  registrations: [
    {
      manifest: {
        name: "hook-plugin",
        displayName: "Hook Plugin",
        description: "Hook-backed local chat test plugin",
      },
      hooks: {},
    },
  ],
};
`,
    );
    process.chdir(tempDir);

    try {
      const io = {
        error: vi.fn(),
        input: process.stdin,
        output: process.stdout,
        write: vi.fn(),
      };

      expect(await runChat(["-p", "hello"], io)).toBe(1);
      expect(io.error).toHaveBeenCalledWith("DATABASE_URL is required");
      expect(runner.runLocalAgentTurn).not.toHaveBeenCalled();
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("fails local chat for unresolved plugin packages", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "junior-chat-plugins-"));
    writeFileSync(
      path.join(tempDir, "plugins.mjs"),
      `export const plugins = {
  packageNames: ["@sentry/junior-missing-plugin"],
  registrations: [],
};
`,
    );
    process.chdir(tempDir);

    try {
      const io = {
        error: vi.fn(),
        input: process.stdin,
        output: process.stdout,
        write: vi.fn(),
      };

      expect(await runChat(["-p", "hello"], io)).toBe(1);
      expect(io.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Plugin package "@sentry/junior-missing-plugin" was configured but could not be resolved',
        ),
      );
      expect(runner.runLocalAgentTurn).not.toHaveBeenCalled();
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("loads TypeScript local plugin modules before prompt local chat", async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "junior-chat-plugins-"));
    writeFileSync(
      path.join(tempDir, "plugins.js"),
      `export const plugins = {
  packageNames: [],
  registrations: [
    {
      manifest: {
        name: "javascript-plugin",
        displayName: "JavaScript Plugin",
        description: "JavaScript local plugin module test",
      },
    },
  ],
};
`,
    );
    writeFileSync(
      path.join(tempDir, "plugins.ts"),
      `const packageNames: string[] = [];

export const plugins = {
  packageNames,
  registrations: [
    {
      manifest: {
        name: "typescript-plugin",
        displayName: "TypeScript Plugin",
        description: "TypeScript local plugin module test",
      },
    },
  ],
};
`,
    );
    process.chdir(tempDir);
    runner.runLocalAgentTurn.mockImplementation(async (_input, deps) => {
      const result = reply("success");
      await deps.deliverReply(result.reply);
      return result;
    });

    try {
      const io = {
        error: vi.fn(),
        input: process.stdin,
        output: process.stdout,
        write: vi.fn(),
      };

      expect(await runChat(["-p", "hello"], io)).toBe(0);
      expect(runner.runLocalAgentTurn).toHaveBeenCalledOnce();
      const { pluginCatalogRuntime } =
        await import("@/chat/plugins/catalog-runtime");
      const pluginNames = pluginCatalogRuntime
        .getProviders()
        .map((plugin) => plugin.manifest.name);
      expect(pluginNames).toContain("typescript-plugin");
      expect(pluginNames).not.toContain("javascript-plugin");
    } finally {
      process.chdir(ORIGINAL_CWD);
      rmSync(tempDir, { force: true, recursive: true });
    }
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
    const { getChatConfig } = await import("@/chat/config");
    expect(getChatConfig().state.adapter).toBe("redis");
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
    const { getChatConfig } = await import("@/chat/config");
    expect(getChatConfig().state.adapter).toBe("memory");
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
    await waitForMockCalls(runner.runLocalAgentTurn, 1);
    input.write("again\n");
    await waitForMockCalls(runner.runLocalAgentTurn, 2);
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
