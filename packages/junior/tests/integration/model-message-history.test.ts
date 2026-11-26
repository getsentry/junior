import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  mockAnthropicStream,
  withoutCacheMarkers,
} from "../fixtures/anthropic-stream";
import { connectedState } from "@/chat/cache-warming/request";
import { loadSnapshot, saveSnapshot } from "@/chat/cache-warming/snapshot";
import { commitMessages } from "@/chat/conversations/projection";
import { closeConversationFixture } from "../fixtures/conversation";
import { createAgent } from "../fixtures/agent";
import { createWorkspace, deleteWorkspace } from "@/chat/workspaces/store";
import { installTestSkills } from "../fixtures/skill-dirs";
import { mockTitleModel } from "../fixtures/title-model";
import { signedInViewer } from "../fixtures/user";
import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { inboxItemListSchema } from "@/api/schema";
import { getDb, getSqlExecutor } from "@/chat/db";
import { juniorConversationParticipants } from "@/db/schema";
import { changeTodos, setTodoStatusByUser } from "@/chat/todos/store";

/** The dashboard API as one signed-in person. */
function personApi(viewer: User) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("model message history", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });
  it("preserves native messages and provider request prefixes across Turns", async () => {
    const toolArguments = {
      message: "Checking the result\u0000before replying.",
    };
    mockTitleModel("Conversation title");
    const requests = mockAnthropicStream("openai/gpt-6-astra", [
      [
        {
          type: "thinking",
          thinking: "Check the plan.",
          signature: "opaque-signature",
        },
        { type: "redacted_thinking", data: "opaque-redacted-data" },
        {
          type: "tool_use",
          id: "progress-call",
          name: "reportProgress",
          input: toolArguments,
        },
      ],
      [{ type: "text", text: "First response." }],
      [{ type: "text", text: "Second response." }],
    ]);
    const agent = await createAgent({
      modelStream: streamSimple,
      botConfig: { modelId: "openai/gpt-6-astra", reasoningLevel: "low" },
    });

    await agent.run("first\u0000request and literal \\u0000");
    const first = agent.snapshot();

    await agent.run("second request");
    const second = agent.snapshot();

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(first.messages).toContainEqual(
      expect.objectContaining({ role: "toolResult", isError: false }),
    );
    const firstAssistant = first.messages.find(
      (message) => message.role === "assistant",
    );
    expect(firstAssistant?.content).toMatchObject([
      { type: "thinking", thinkingSignature: "opaque-signature" },
      {
        type: "thinking",
        thinkingSignature: "opaque-redacted-data",
        redacted: true,
      },
      { type: "toolCall", arguments: toolArguments },
    ]);
    const stored = await agent.agentHistory();
    expect(
      JSON.stringify(
        stored.find((message) => message.role === "assistant")?.content,
      ),
    ).toBe(JSON.stringify(firstAssistant?.content));
    // The request folds the first sections message into the system prompt.
    expect(stored[0]?.role).toBe("system");
    expect(stored.slice(1, first.messages.length + 1)).toEqual(first.messages);
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.sessionAffinity)).toEqual(
      Array(3).fill(agent.conversationId()),
    );
    const before = requests[1]!;
    const after = requests[2]!;
    expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
    // This model takes no later system messages, so Pi collapses the
    // capability sections into the system prompt.
    expect(JSON.stringify(requests[0]!.system)).toContain("<script-tools>");
    expect(JSON.stringify(after.messages)).not.toContain("<script-tools>");
    // Do not sort in the assertion: the real provider bytes must already match.
    expect(
      JSON.stringify(
        withoutCacheMarkers(after.messages.slice(0, before.messages.length)),
      ),
    ).toBe(JSON.stringify(withoutCacheMarkers(before.messages)));
  });

  it("replays a saved system message in place on every request", async () => {
    mockTitleModel("Conversation title");
    const agent = await createAgent({
      responses: ["First.", "Second.", "Third."],
    });
    await agent.run("first");
    // No runtime path writes a later system message yet, so commit one as
    // the next history item, where Pi would put it.
    const saved = {
      role: "system" as const,
      content: "Prefer short replies.",
      sections: { skills: "<available-skills>\nnone\n</available-skills>" },
      timestamp: Date.now(),
    };
    const firstHistory = await agent.agentHistory();
    await commitMessages({
      conversationId: agent.conversationId(),
      messages: [...firstHistory, saved],
    });

    await agent.run("second");
    const second = agent.snapshot();
    await agent.run("third");
    const third = agent.snapshot();

    expect((await agent.agentHistory())[firstHistory.length]).toEqual(saved);
    // The request folds the first sections message into the system prompt,
    // so the saved one is one message earlier there.
    expect(second.messages[firstHistory.length - 1]).toEqual(saved);
    expect(
      JSON.stringify(third.messages.slice(0, second.messages.length)),
    ).toBe(JSON.stringify(second.messages));
    // Cache warming stores this request context and sends it again.
    const state = await connectedState();
    const key = `snapshot:${agent.conversationId()}`;
    await saveSnapshot(state, agent.conversationId(), key, third, 60_000);
    await expect(
      loadSnapshot(state, agent.conversationId(), key),
    ).resolves.toEqual(third);
  });

  it("sends a capability section again only when it changed", async () => {
    mockTitleModel("Conversation title");
    const agent = await createAgent({
      responses: ["First.", "Second.", "Third.", "Fourth."],
    });
    const sectionUpdates = async () =>
      (await agent.agentHistory()).flatMap((message) =>
        message.role === "system" ? [message.sections ?? {}] : [],
      );

    await agent.run("first");
    const first = agent.snapshot();
    const [initial] = await sectionUpdates();
    expect(Object.keys(initial!)).toEqual(
      expect.arrayContaining(["available-skills", "script-tools"]),
    );
    expect(initial).not.toHaveProperty("workspaces");
    // The first sections apply from the start, so the request folds them
    // into the system prompt instead of sending them after the instruction.
    expect(first.messages.map((message) => message.role)).not.toContain(
      "system",
    );
    // A deploy adds a skill, and someone creates a Workspace.
    const removeSkills = await installTestSkills([
      {
        name: "release-notes",
        description: "Write release notes.",
        body: "Write them.",
      },
    ]);
    const workspace = await createWorkspace({
      name: "docs",
      repos: [{ provider: "github", repo: "getsentry/docs" }],
    });
    try {
      await agent.run("second");
      const second = agent.snapshot();
      await agent.run("third");

      // One system message after the cached prefix sets only the changed
      // sections. The next Turn sets none.
      expect(second.systemPrompt).toBe(first.systemPrompt);
      expect(second.messages.slice(0, first.messages.length)).toEqual(
        first.messages,
      );
      expect(
        second.messages
          .slice(first.messages.length)
          .map((message) => message.role),
      ).toContain("system");
      const updates = await sectionUpdates();
      expect(updates).toHaveLength(2);
      expect(Object.keys(updates[1]!).sort()).toEqual([
        "available-skills",
        "workspaces",
      ]);
      expect(updates[1]!["available-skills"]).toContain(
        "<name>release-notes</name>",
      );
      expect(updates[1]!["workspaces"]).toContain("- docs: getsentry/docs");
    } finally {
      await removeSkills();
      await deleteWorkspace(workspace.id);
    }

    // Both changes are undone. An empty section is removed.
    await agent.run("fourth");
    const undone = (await sectionUpdates()).at(-1)!;
    expect(Object.keys(undone).sort()).toEqual([
      "available-skills",
      "workspaces",
    ]);
    expect(undone["available-skills"]).not.toContain("release-notes");
    expect(undone["workspaces"]).toBeNull();
  });

  it("sends To-do changes that a person made once, and none for the agent's own", async () => {
    mockTitleModel("Conversation title");
    const agent = await createAgent({
      responses: ["First.", "Second.", "Third.", "Fourth."],
    });
    const newText = (
      before: { messages: unknown[] },
      after: { messages: unknown[] },
    ) => JSON.stringify(after.messages.slice(before.messages.length));
    const deltas = (text: string) =>
      text.split('<plugin-contribution plugin=\\"todos\\" id=\\"userPrompt:')
        .length - 1;

    await agent.run("first");
    const first = agent.snapshot();
    // The agent's own changes are already in its tool results. The To-dos
    // are in the database, so a fresh session reads the same ones.
    const self = { conversationId: agent.conversationId() };
    const person = await signedInViewer("person@example.com");
    await getDb().insert(juniorConversationParticipants).values({
      lastMessageAt: new Date(),
      rootConversationId: agent.conversationId(),
      userId: person.id,
    });
    const {
      todos: [, send, approve],
    } = await changeTodos(getSqlExecutor(), {
      conversationId: agent.conversationId(),
      nowMs: Date.now(),
      change: {
        add: [
          { title: "Draft the brief", status: "open", assignee: self },
          { title: "Send the brief", status: "open", assignee: self },
          {
            title: "Approve the brief",
            status: "open",
            assignee: { userId: person.id },
          },
        ],
        update: [],
        remove: [],
      },
    });
    await agent.run("second");
    const second = agent.snapshot();
    expect(deltas(newText(first, second))).toBe(0);

    await setTodoStatusByUser(getSqlExecutor(), {
      conversationId: agent.conversationId(),
      id: send!.id,
      nowMs: Date.now(),
      status: "dropped",
      userId: person.id,
    });
    // The person marks their own To-do done in the Inbox.
    const inbox = personApi(person);
    const { items } = inboxItemListSchema.parse(
      await (
        await inbox.request("http://localhost/api/inbox-items?for=viewer")
      ).json(),
    );
    expect(items.map((item) => item.todoId)).toEqual([approve!.id]);
    expect(
      (
        await inbox.request(
          `http://localhost/api/inbox-items/${items[0]!.id}/actions`,
          {
            body: JSON.stringify({ action: "done" }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        )
      ).status,
    ).toBe(200);
    await agent.run("third");
    const third = agent.snapshot();
    const delta = newText(second, third);
    expect(deltas(delta)).toBe(1);
    expect(delta).toContain(
      `- TODO-${send!.id} (dropped, assignee self, changed by person@example.com): Send the brief`,
    );
    expect(delta).toContain(
      `- TODO-${approve!.id} (done, assignee person@example.com, changed by person@example.com): Approve the brief`,
    );
    expect(delta).not.toContain("Draft the brief");
    // The block stays in history, so the next Turn does not send it again.
    await agent.run("fourth");
    expect(deltas(newText(third, agent.snapshot()))).toBe(0);
  });
  it("sends the open To-dos again after a few Turns without a To-do change", async () => {
    mockTitleModel("Conversation title");
    const agent = await createAgent({
      responses: Array.from({ length: 7 }, (_, index) => `Reply ${index}.`),
    });
    await agent.run("first");
    const self = { conversationId: agent.conversationId() };
    const {
      todos: [open],
    } = await changeTodos(getSqlExecutor(), {
      conversationId: agent.conversationId(),
      nowMs: Date.now(),
      change: {
        add: [
          {
            title: "Renumber the migration",
            status: "open",
            assignee: self,
          },
          { title: "Merge the runner", status: "done", assignee: self },
        ],
        update: [],
        remove: [],
      },
    });
    const turnText = new Map<string, string>();
    for (const input of ["second", "third", "fourth", "fifth", "sixth"]) {
      const before = agent.snapshot();
      await agent.run(input);
      turnText.set(
        input,
        JSON.stringify(agent.snapshot().messages.slice(before.messages.length)),
      );
    }
    // The review is a To-do block, so it waits for the next interval.
    expect(
      [...turnText]
        .filter(([, text]) =>
          text.includes(
            '<plugin-contribution plugin=\\"todos\\" id=\\"userPrompt:',
          ),
        )
        .map(([input]) => input),
    ).toEqual(["fourth"]);
    expect(turnText.get("fourth")).toContain(
      `- TODO-${open!.id} (open, assignee self): Renumber the migration`,
    );
    expect(turnText.get("fourth")).not.toContain("Merge the runner");
  });
});
