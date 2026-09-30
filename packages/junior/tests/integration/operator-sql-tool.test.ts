import { afterEach, describe, expect, it } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import { closeDb, getConversationStore } from "@/chat/db";
import { setExperimentalFeatures } from "@/chat/experimental";
import { createOperatorTools } from "@/chat/tools/operator-sql";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { SUITE_EXPERIMENTAL } from "../fixtures/experimental-setup";

const CONVERSATION_ID = "local:operator:current";

function context(
  conversationPrivacy: ToolRuntimeContext["conversationPrivacy"],
): ToolRuntimeContext {
  return {
    conversationId: CONVERSATION_ID,
    conversationPrivacy,
    destination: { platform: "local", conversationId: CONVERSATION_ID },
    source: createLocalSource(CONVERSATION_ID),
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    workspace: {} as ToolRuntimeContext["workspace"],
  };
}

async function runSql(input: Record<string, unknown>): Promise<any> {
  const tool = createOperatorTools(context("private")).runOperatorSql;
  if (!tool?.execute || !tool.prepareArguments) {
    throw new Error("runOperatorSql is missing");
  }
  return await tool.execute(tool.prepareArguments(input), {});
}

describe("operator SQL tool", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("exists only when the app opts in, and never in public Conversations", () => {
    expect(createOperatorTools(context("private"))).toEqual({});

    setExperimentalFeatures({ ...SUITE_EXPERIMENTAL, "operator-tools": true });
    expect(Object.keys(createOperatorTools(context("private")))).toEqual([
      "runOperatorSql",
    ]);
    expect(createOperatorTools(context("public"))).toEqual({});
  });

  it("reads and writes the deployment database and reports SQL mistakes", async () => {
    setExperimentalFeatures({ ...SUITE_EXPERIMENTAL, "operator-tools": true });
    await getConversationStore().recordActivity({
      conversationId: CONVERSATION_ID,
      destination: { platform: "local", conversationId: CONVERSATION_ID },
      nowMs: 1_000,
      source: "local",
      title: "Before",
      visibility: "private",
    });

    const updated = await runSql({
      statement:
        "UPDATE junior_conversations SET title = $1 WHERE conversation_id = $2 RETURNING title",
      params: ["After", CONVERSATION_ID],
    });
    expect(updated).toMatchObject({
      row_count: 1,
      rows: [{ title: "After" }],
      truncated: false,
    });

    const limited = await runSql({
      statement: "SELECT generate_series(1, 5) AS n",
      row_limit: 2,
    });
    expect(limited).toMatchObject({
      row_count: 5,
      rows: [{ n: 1 }, { n: 2 }],
      truncated: true,
    });

    const mistake = runSql({ statement: "SELECT * FROM missing_table" });
    await expect(mistake).rejects.toBeInstanceOf(ToolInputError);
    await expect(mistake).rejects.toThrow("SQL error 42P01");
  });
});
