import { createLocalSource } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { linearPlugin } from "../../../junior-linear/src/index.js";
import { getConversationStore, getDb } from "@/chat/db";
import {
  getPluginTools,
  setPlugins,
} from "@/chat/plugins/agent-hooks";
import { listConversationAnnotations } from "@/chat/plugins/annotations";

const conversationId = "local:test:linear-native-create";
const destination = { platform: "local" as const, conversationId };

describe("Linear native create", () => {
  let previousPlugins: ReturnType<typeof setPlugins> | undefined;

  afterEach(() => {
    if (previousPlugins) {
      setPlugins(previousPlugins);
      previousPlugins = undefined;
    }
  });

  it("creates and annotates an issue through plugin tool wiring", async () => {
    previousPlugins = setPlugins([linearPlugin()]);
    await getConversationStore().recordActivity({
      conversationId,
      destination,
      nowMs: Date.now(),
      source: "local",
      title: "Linear native create",
    });
    const requests: Array<{
      operation: string;
      provider: string;
      request: Request;
    }> = [];
    const tools = getPluginTools({
      conversationId,
      destination,
      egress: {
        async fetch(input) {
          requests.push(input);
          return Response.json({
            data: {
              issueCreate: {
                success: true,
                issue: {
                  id: "issue-id",
                  identifier: "ENG-123",
                  title: "Native Linear issue",
                  description: null,
                  priority: 3,
                  url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
                  state: { id: "state-id", name: "Todo" },
                  team: {
                    id: "team-id",
                    key: "ENG",
                    name: "Engineering",
                  },
                  project: null,
                },
              },
            },
          });
        },
      },
      source: createLocalSource(conversationId),
      workspace: {} as never,
    });
    const createIssue = tools.linear_createIssue;
    if (!createIssue?.execute) {
      throw new Error("linear_createIssue tool is missing");
    }

    await expect(
      createIssue.execute(
        { teamId: "team-id", title: "Native Linear issue" },
        { toolCallId: "create-linear-issue" },
      ),
    ).resolves.toMatchObject({
      issue: {
        identifier: "ENG-123",
        url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "linear.issue.create",
      provider: "linear",
    });
    expect(requests[0]?.request.headers.has("authorization")).toBe(false);
    await expect(
      listConversationAnnotations(getDb(), conversationId),
    ).resolves.toMatchObject([
      {
        kind: "resource_link",
        key: "ENG-123",
        label: "ENG-123",
        plugin: "linear",
        status: "open",
        url: "https://linear.app/acme/issue/ENG-123/native-linear-issue",
      },
    ]);
  });
});
