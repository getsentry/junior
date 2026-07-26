import { describe, expect, it } from "vitest";
import {
  createLocalSource,
  type PluginLogger,
  type PluginState,
  type PluginTaskContext,
} from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { createPluginModel } from "@/chat/plugins/model";
import { classifyTurn } from "../../../junior-conversation-classification/src/classify";
import { juniorConversationClassifications } from "../../../junior-conversation-classification/src/db/schema";
import { DEFAULT_TURN_INTENT_TAXONOMY } from "../../../junior-conversation-classification/src/types";

const logger: PluginLogger = {
  error() {},
  info() {},
  warn() {},
};

const state: PluginState = {
  async delete() {},
  async get() {
    return undefined;
  },
  async set() {},
  async setIfNotExists() {
    return true;
  },
  async withLock(_key, _ttlMs, callback) {
    return await callback();
  },
};

const cases = [
  {
    categoryId: "product_question",
    prompt:
      "How should our team configure custom categories for Junior conversation classification?",
  },
  {
    categoryId: "customer_support",
    prompt:
      "Draft a reply to a customer whose SSO login stopped working after their email domain changed.",
  },
  {
    categoryId: "code_change",
    prompt:
      "Add validation to reject duplicate category ids and update the relevant tests.",
  },
  {
    categoryId: "bug_investigation",
    prompt:
      "Investigate why the duplicate-category validation test fails even though the input contains two identical ids. Do not change code yet.",
  },
  {
    categoryId: "incident_response",
    prompt:
      "Production API errors doubled after the latest deployment. Help investigate and recommend immediate mitigation.",
  },
  {
    categoryId: "operational_analysis",
    prompt:
      "Compare service latency and error-rate trends before and after last week's deployment; there is no active incident.",
  },
  {
    categoryId: "product_analysis",
    prompt:
      "Analyze signup conversion, activation, and 30-day retention for the latest onboarding experiment.",
  },
  {
    categoryId: "decision_support",
    prompt:
      "Compare a company-wide launch with a two-team pilot and recommend which rollout approach we should choose.",
  },
] as const;

function taskContext(
  prompt: string,
  conversationId: string,
): PluginTaskContext {
  return {
    db: getDb(),
    embedder: {
      async embedTexts() {
        return {
          dimensions: 1,
          model: "unused",
          provider: "unused",
          vectors: [[0]],
        };
      },
    },
    id: `eval:${conversationId}`,
    log: logger,
    model: createPluginModel("conversation-classification"),
    name: "classifyTurn",
    plugin: { name: "conversation-classification" },
    run: {
      async load() {
        return {
          actor: { platform: "local", userId: "eval-user" },
          actors: [{ platform: "local", userId: "eval-user" }],
          completedAtMs: Date.now(),
          conversationId,
          destination: { platform: "local", conversationId },
          runId: "eval-turn-1",
          source: createLocalSource(conversationId),
          transcript: [
            {
              type: "message",
              role: "user",
              text: prompt,
              provenance: {
                authority: "instruction",
                actor: { platform: "local", userId: "eval-user" },
              },
              isRunActor: true,
            },
            {
              type: "message",
              role: "assistant",
              text: "Acknowledged.",
            },
          ],
          visibility: "private",
        };
      },
    },
    state,
  };
}

describe("Conversation Classification", () => {
  for (const [index, testCase] of cases.entries()) {
    it(`classifies ${testCase.categoryId}`, async () => {
      const db = getDb();
      await db.delete(juniorConversationClassifications);
      const record = await classifyTurn(
        taskContext(
          testCase.prompt,
          `local:classification-eval:case-${index + 1}`,
        ),
        {
          maxTranscriptChars: 12_000,
          retentionMs: 90 * 86_400_000,
          taxonomy: DEFAULT_TURN_INTENT_TAXONOMY,
        },
      );
      expect(record?.categoryId).toBe(testCase.categoryId);
    });
  }
});
