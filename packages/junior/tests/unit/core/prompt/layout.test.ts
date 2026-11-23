import { describe, expect, expectTypeOf, it } from "vitest";
import {
  definePromptLayout,
  fragment,
  inputs,
  loader,
  type PromptLayout,
} from "@/core/prompt/layout";

const turnRow = loader(
  "turn-row",
  (ctx) => Promise.resolve({ turnId: ctx.turn.turnId }),
  { timeoutMs: 100 },
);

function userText(content: string) {
  return { role: "user" as const, content };
}

function inputsFragment() {
  return inputs({
    format: (input) => ({
      message: userText(String(input.payload["text"])),
      provenance: { authority: "instruction" },
    }),
  });
}

describe("definePromptLayout", () => {
  it("throws on an empty or repeated system prompt section name", () => {
    expect(() =>
      definePromptLayout({
        systemPrompt: [{ name: "", text: "You are Junior." }],
        messages: [inputsFragment()],
      }),
    ).toThrow("A system prompt section has no name");
    expect(() =>
      definePromptLayout({
        systemPrompt: [
          { name: "identity", text: "You are Junior." },
          { name: "identity", text: "You work at Sentry." },
        ],
        messages: [inputsFragment()],
      }),
    ).toThrow('Two system prompt sections are named "identity"');
  });

  it("freezes the system prompt sections", () => {
    const sections = [{ name: "identity", text: "You are Junior." }];
    const unread = inputsFragment();
    const layout = definePromptLayout({
      systemPrompt: sections,
      messages: [unread],
    });

    sections[0]!.text = "You are someone else.";

    expect(layout).toEqual({
      systemPrompt: [{ name: "identity", text: "You are Junior." }],
      messages: [unread],
    });
    expect(Object.isFrozen(layout.systemPrompt)).toBe(true);
    expect(Object.isFrozen(layout.systemPrompt[0])).toBe(true);
  });

  it("freezes the messages list", () => {
    const first = fragment("first", { format: () => userText("First") });
    const unread = inputsFragment();
    const messages = [first, unread];
    const layout = definePromptLayout({ systemPrompt: [], messages });

    messages.push(fragment("second", { format: () => userText("Second") }));

    expect(layout.messages).toEqual([first, unread]);
    expect(Object.isFrozen(layout.messages)).toBe(true);
  });

  it("throws on two fragments with one name", () => {
    expect(() =>
      definePromptLayout({
        systemPrompt: [],
        messages: [
          fragment("turn", { loader: turnRow, format: () => userText("A") }),
          fragment("turn", { format: () => userText("B") }),
          inputsFragment(),
        ],
      }),
    ).toThrow('Two fragments are named "turn"');
  });

  it("throws on one fragment used twice", () => {
    const turn = fragment("turn", {
      loader: turnRow,
      format: (row) => userText(row.turnId),
    });

    expect(() =>
      definePromptLayout({
        systemPrompt: [],
        messages: [turn, turn, inputsFragment()],
      }),
    ).toThrow('Fragment "turn" is used more than once');
  });

  it("throws on two loaders with one label", () => {
    const otherTurnRow = loader("turn-row", () => Promise.resolve("B"), {
      timeoutMs: 100,
    });

    expect(() =>
      definePromptLayout({
        systemPrompt: [],
        messages: [
          fragment("first", {
            loader: turnRow,
            format: (row) => userText(row.turnId),
          }),
          fragment("second", { loader: otherTurnRow, format: userText }),
          inputsFragment(),
        ],
      }),
    ).toThrow('Two loaders are labeled "turn-row"');
  });

  it("throws unless the messages hold exactly one inputs fragment", () => {
    const first = fragment("first", { format: () => userText("First") });

    expect(() =>
      definePromptLayout({ systemPrompt: [], messages: [first] }),
    ).toThrow("A prompt layout needs exactly one inputs() fragment, not 0");
    expect(() =>
      definePromptLayout({
        systemPrompt: [],
        messages: [inputsFragment(), first, inputsFragment()],
      }),
    ).toThrow("A prompt layout needs exactly one inputs() fragment, not 2");
  });

  it("takes only static sections in the system prompt", () => {
    type SystemPromptSection = PromptLayout["systemPrompt"][number];
    type MessageFragment = PromptLayout["messages"][number];

    expectTypeOf(
      fragment("identity", { format: () => "You are Junior." }),
    ).not.toExtend<SystemPromptSection>();
    definePromptLayout({
      // @ts-expect-error A fragment is not a system prompt section.
      systemPrompt: [fragment("identity", { format: () => "You are Junior." })],
      messages: [inputsFragment()],
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
