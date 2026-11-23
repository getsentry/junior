import { pluginApiRouteRequestContextSchema } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryApi, memorySearchResponseSchema } from "@/chat/memory/api";
import { publicMemoryScope } from "@/chat/memory/scope";
import { memoryDb } from "@/chat/memory/store";
import { closeDb, getDb } from "@/chat/db";
import { juniorMemoryMemories } from "@/db/schema/memory";
import {
  expectNoFullScan,
  expectSqlBudget,
} from "../../../fixtures/sql-budget";

const CREATED_MS = Date.parse("2026-08-20T12:00:00.000Z");

/** The memory API, signed in as one person. */
function signedIn(email: string) {
  const api = createMemoryApi({
    conversationEvents: {
      async list() {
        return [];
      },
    },
    db: memoryDb(getDb()),
    eventStats: {
      async costsByDay() {
        return [];
      },
      async costsByHour() {
        return [];
      },
    },
    users: {
      async resolve(viewer) {
        return { email: viewer, id: "viewer", identities: [] };
      },
    },
  });
  const context = pluginApiRouteRequestContextSchema.parse({
    auth: { user: { email, emailVerified: true, isAdmin: false } },
    pluginName: "memory",
  });
  const request = (query: string, signedOut = false) =>
    api.fetch(
      new Request(
        `http://localhost/search?${new URLSearchParams({ q: query })}`,
      ),
      signedOut ? undefined : context,
    );
  const search = async (query: string) => {
    const response = await request(query);
    expect(response.status).toBe(200);
    return memorySearchResponseSchema
      .parse(await response.json())
      .memories.map((memory) => memory.id);
  };
  return { request, search };
}

async function memory(
  id: string,
  content: string,
  options: {
    archived?: boolean;
    expired?: boolean;
    minute?: number;
    privateTo?: string;
    superseded?: boolean;
  } = {},
) {
  const scope = options.privateTo
    ? { scope: "private" as const, scopeKey: options.privateTo }
    : publicMemoryScope;
  await getDb()
    .insert(juniorMemoryMemories)
    .values({
      ...(options.archived ? { archivedAtMs: CREATED_MS } : undefined),
      ...(options.expired ? { expiresAtMs: CREATED_MS } : undefined),
      ...(options.superseded
        ? { supersededAtMs: CREATED_MS, supersededById: "newer" }
        : undefined),
      content,
      createdAtMs: CREATED_MS + (options.minute ?? 0) * 60_000,
      id,
      kind: "knowledge",
      observedAtMs: CREATED_MS,
      scope: scope.scope,
      scopeKey: scope.scopeKey,
      sourceKey: `slack:T1:C1:${id}`,
      sourcePlatform: "slack",
      subjectKey: null,
      subjectType: "general",
    });
}

describe("memory search API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("finds active public memory by word prefixes, newest first", async () => {
    await memory("runbook", "Deploy runbooks live in Notion.", { minute: 1 });
    await memory("rollback", "Deployments roll back from GoCD.", {
      minute: 2,
    });
    await memory("mine", "Deploy notes only I keep.", { privateTo: "viewer" });
    await memory("theirs", "Deploy notes Bea keeps.", { privateTo: "bea" });
    await memory("archived", "Deploy with the old script.", {
      archived: true,
    });
    await memory("superseded", "Deploy from the release branch.", {
      superseded: true,
    });
    await memory("expired", "Deploy freeze this week.", { expired: true });
    const { search } = signedIn("ana@example.com");

    const found = await expectSqlBudget(() => search("depl"), {
      statements: 1,
      serialRounds: 1,
    });
    await expectNoFullScan(() => search("depl"));
    // Private, archived, superseded, and expired memories never show.
    expect(found).toEqual(["rollback", "runbook"]);
    expect(await search("deploy NOT")).toEqual(["runbook"]);
    expect(await search("gocd")).toEqual(["rollback"]);
    // A word must start a word of the memory.
    expect(await search("ploy")).toEqual([]);
    // Punctuation is not tsquery syntax.
    expect(await search("&|!")).toEqual([]);
  });

  it("returns at most 8 memories and rejects an empty query", async () => {
    for (let minute = 1; minute <= 10; minute += 1) {
      await memory(`step-${minute}`, `Ship step ${minute}.`, { minute });
    }
    const { request, search } = signedIn("ana@example.com");

    expect(await search("ship")).toEqual([
      "step-10",
      "step-9",
      "step-8",
      "step-7",
      "step-6",
      "step-5",
      "step-4",
      "step-3",
    ]);
    expect((await request(" ")).status).toBe(400);
    expect((await request("ship", true)).status).toBe(401);
  });
});
