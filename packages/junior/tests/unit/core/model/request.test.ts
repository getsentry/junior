import { describe, expect, expectTypeOf, it } from "vitest";
import type { ModelSettings } from "@/core/model/client";
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
const turnRow = loader(
  "turn-row",
  (ctx) => Promise.resolve({ turnId: ctx.turn.turnId }),
  { timeoutMs: 100 },
);

function userText(content: string) {
  return { role: "user" as const, content, timestamp: 0 };
}

describe("defineModelRequest", () => {
  it("throws on an empty or repeated system prompt part name", () => {
    expect(() =>
      defineModelRequest({
        systemPrompt: [{ name: "", text: "You are Junior." }],
        messages: [],
        model,
      }),
    ).toThrow("A system prompt part has no name");
    expect(() =>
      defineModelRequest({
        systemPrompt: [
          { name: "identity", text: "You are Junior." },
          { name: "identity", text: "You work at Sentry." },
        ],
        messages: [],
        model,
      }),
    ).toThrow('Two system prompt parts are named "identity"');
  });

  it("freezes the system prompt parts", () => {
    const parts = [{ name: "identity", text: "You are Junior." }];
    const spec = defineModelRequest({
      systemPrompt: parts,
      messages: [],
      model,
    });

    parts[0]!.text = "You are someone else.";

    expect(spec).toEqual({
      systemPrompt: [{ name: "identity", text: "You are Junior." }],
      messages: [],
      model,
    });
    expect(Object.isFrozen(spec.systemPrompt)).toBe(true);
    expect(Object.isFrozen(spec.systemPrompt[0])).toBe(true);
  });

  it("throws on two fragments with one name", () => {
    expect(() =>
      defineModelRequest({
        systemPrompt: [],
        messages: [
          fragment("turn", { loader: turnRow, format: () => userText("A") }),
          fragment("turn", { format: () => userText("B") }),
        ],
        model,
      }),
    ).toThrow('Two fragments are named "turn"');
  });

  it("throws on one fragment used twice", () => {
    const turn = fragment("turn", {
      loader: turnRow,
      format: (row) => userText(row.turnId),
    });

    expect(() =>
      defineModelRequest({ systemPrompt: [], messages: [turn, turn], model }),
    ).toThrow('Fragment "turn" is used more than once');
  });

  it("throws on two loaders with one label", () => {
    const otherTurnRow = loader("turn-row", () => Promise.resolve("B"), {
      timeoutMs: 100,
    });

    expect(() =>
      defineModelRequest({
        systemPrompt: [],
        messages: [
          fragment("first", {
            loader: turnRow,
            format: (row) => userText(row.turnId),
          }),
          fragment("second", { loader: otherTurnRow, format: userText }),
        ],
        model,
      }),
    ).toThrow('Two loaders are labeled "turn-row"');
  });

  it("takes only static parts in the system prompt", () => {
    type SystemPromptPart = ModelRequestLayout["systemPrompt"][number];
    type MessageFragment = ModelRequestLayout["messages"][number];

    expectTypeOf(
      fragment("identity", { format: () => "You are Junior." }),
    ).not.toExtend<SystemPromptPart>();
    defineModelRequest({
      // @ts-expect-error A fragment is not a system prompt part.
      systemPrompt: [fragment("identity", { format: () => "You are Junior." })],
      messages: [],
      model,
    });
    // Message fragments must give messages.
    expectTypeOf(
      fragment("turn", {
        loader: turnRow,
        format: (row, ctx) => userText(`${row.turnId} ${ctx.turn.stepSeq}`),
      }),
    ).toExtend<MessageFragment>();
    expectTypeOf(
      fragment("identity", { format: () => "You are Junior." }),
    ).not.toExtend<MessageFragment>();
  });

  it("gives `undefined` to the fragments of an optional loader", () => {
    const count = loader("count", () => Promise.resolve(3), {
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
