import { describe, expect, expectTypeOf, it } from "vitest";
import type { ModelSettings } from "@/core/model/client";
import type { ToolDefinition } from "@/core/tool";
import {
  defineModelRequest,
  fragment,
  loader,
  type ModelRequestLayout,
} from "@/core/model/request";

const MODEL: ModelSettings = {
  id: "anthropic/claude-sonnet-4.5",
  reasoning: "low",
  privacy: "public",
};
const model = fragment("model", { format: () => MODEL });
const soul = loader("soul", () => Promise.resolve("You are Junior."), {
  lifetime: "deployment",
  timeoutMs: 100,
});
const turnRow = loader(
  "turn-row",
  (ctx) => Promise.resolve({ turnId: ctx.turn.turnId }),
  { lifetime: "step", timeoutMs: 100 },
);

describe("defineModelRequest", () => {
  it("throws on two fragments with one name", () => {
    expect(() =>
      defineModelRequest({
        systemPrompt: [
          fragment("soul", { loader: soul, format: (text) => text }),
          fragment("soul", { format: () => "Be brief." }),
        ],
        tools: [],
        messages: [],
        model,
      }),
    ).toThrow('Two fragments are named "soul"');
  });

  it("throws on one fragment used twice", () => {
    const soulText = fragment("soul", { loader: soul, format: (text) => text });

    expect(() =>
      defineModelRequest({
        systemPrompt: [soulText, soulText],
        tools: [],
        messages: [],
        model,
      }),
    ).toThrow('Fragment "soul" is used more than once');
  });

  it("throws on two loaders with one label", () => {
    const otherSoul = loader("soul", () => Promise.resolve("Be brief."), {
      lifetime: "deployment",
      timeoutMs: 100,
    });

    expect(() =>
      defineModelRequest({
        systemPrompt: [
          fragment("soul", { loader: soul, format: (text) => text }),
          fragment("brevity", { loader: otherSoul, format: (text) => text }),
        ],
        tools: [],
        messages: [],
        model,
      }),
    ).toThrow('Two loaders are labeled "soul"');
  });

  it("allows only fragments that do not change between steps in the system prompt and the tools", () => {
    type SystemPromptFragment = ModelRequestLayout["systemPrompt"][number];
    type ToolsFragment = ModelRequestLayout["tools"][number];
    type MessageFragment = ModelRequestLayout["messages"][number];

    expectTypeOf(
      fragment("soul", { loader: soul, format: (text) => text }),
    ).toExtend<SystemPromptFragment>();
    // A step loader gives a new value for each step.
    expectTypeOf(
      fragment("turn", { loader: turnRow, format: (row) => row.turnId }),
    ).not.toExtend<SystemPromptFragment>();
    expectTypeOf(
      fragment("turn-tools", {
        loader: turnRow,
        format: (): ToolDefinition[] => [],
      }),
    ).not.toExtend<ToolsFragment>();
    // `enabled` and the context can change between steps.
    expectTypeOf(
      fragment("turn", { format: (_value, ctx) => ctx.turn.turnId }),
    ).not.toExtend<SystemPromptFragment>();
    expectTypeOf(
      fragment("brevity", { enabled: () => true, format: () => "Be brief." }),
    ).not.toExtend<SystemPromptFragment>();
    // Message fragments may use both, but must give messages.
    expectTypeOf(
      fragment("turn", {
        loader: turnRow,
        format: (row, ctx) => ({
          role: "user" as const,
          content: `${row.turnId} ${ctx.turn.stepSeq}`,
          timestamp: 0,
        }),
      }),
    ).toExtend<MessageFragment>();
    expectTypeOf(
      fragment("soul", { loader: soul, format: (text) => text }),
    ).not.toExtend<MessageFragment>();
  });

  it("gives `undefined` to the fragments of an optional loader", () => {
    const count = loader("count", () => Promise.resolve(3), {
      lifetime: "step",
      timeoutMs: 100,
      optional: true,
    });

    fragment("count", {
      loader: count,
      format: (value) => {
        expectTypeOf(value).toEqualTypeOf<number | undefined>();
        return String(value);
      },
    });
  });
});
