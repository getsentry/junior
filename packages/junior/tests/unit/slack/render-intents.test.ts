import { describe, expect, it } from "vitest";
import {
  renderIntentFallbackText,
  renderSlackIntent,
} from "@/chat/slack/render/renderer";
import {
  slackRenderIntentSchema,
  type SlackRenderIntent,
} from "@/chat/slack/render/intents";

describe("slackRenderIntentSchema", () => {
  it("accepts a valid plain_reply intent", () => {
    const parsed = slackRenderIntentSchema.parse({
      kind: "plain_reply",
      text: "hello world",
    });
    expect(parsed.kind).toBe("plain_reply");
  });

  it("accepts a valid summary_card with all optional fields", () => {
    const parsed = slackRenderIntentSchema.parse({
      actions: [{ label: "Open", url: "https://example.com/pr/1" }],
      body: "Refactors the thing.",
      fields: [
        { label: "Author", value: "octocat" },
        { label: "Status", value: "Open" },
      ],
      kind: "summary_card",
      subtitle: "example/repo#1",
      title: "Add feature flag",
    });
    expect(parsed.kind).toBe("summary_card");
  });

  it("rejects an unknown intent kind", () => {
    expect(() =>
      slackRenderIntentSchema.parse({
        kind: "totally_invented",
        text: "hi",
      }),
    ).toThrow(/Invalid (option|input|discriminator)|kind/i);
  });

  it("rejects summary_card without a title", () => {
    expect(() =>
      slackRenderIntentSchema.parse({
        kind: "summary_card",
        title: "",
      }),
    ).toThrow(/title|too_small|at least/i);
  });

  it("rejects summary_card with an invalid action url", () => {
    expect(() =>
      slackRenderIntentSchema.parse({
        actions: [{ label: "Open", url: "not a url" }],
        kind: "summary_card",
        title: "ok",
      }),
    ).toThrow(/url|Invalid/i);
  });
});

describe("renderSlackIntent - plain_reply", () => {
  it("passes through the text and emits no blocks", () => {
    const render = renderSlackIntent({
      kind: "plain_reply",
      text: "the quick brown fox",
    });
    expect(render.blocks).toBeUndefined();
    expect(render.text).toBe("the quick brown fox");
  });
});

describe("renderSlackIntent - summary_card", () => {
  const intent: SlackRenderIntent = {
    actions: [{ label: "Open PR", url: "https://example.com/pr/42" }],
    body: "Introduces a new flag for rolling out v2.",
    fields: [
      { label: "Author", value: "octocat" },
      { label: "Status", value: "Open" },
    ],
    kind: "summary_card",
    subtitle: "example/repo#42",
    title: "Add feature flag",
  };

  it("emits a section block with title, subtitle, body, and fields", () => {
    const render = renderSlackIntent(intent);
    expect(render.blocks).toBeDefined();
    const [section, actions] = render.blocks!;
    expect(section.type).toBe("section");
    expect("text" in section && section.text?.type).toBe("mrkdwn");
    expect("text" in section && section.text?.text).toContain(
      "*Add feature flag*",
    );
    expect("text" in section && section.text?.text).toContain(
      "_example/repo#42_",
    );
    expect("text" in section && section.text?.text).toContain(
      "Introduces a new flag for rolling out v2.",
    );
    expect(
      "fields" in section ? section.fields?.map((f) => f.text) : undefined,
    ).toEqual(["*Author*\noctocat", "*Status*\nOpen"]);
    expect(actions.type).toBe("actions");
    expect("elements" in actions ? actions.elements[0] : undefined).toEqual({
      text: { emoji: true, text: "Open PR", type: "plain_text" },
      type: "button",
      url: "https://example.com/pr/42",
    });
  });

  it("omits the actions block when no actions are provided", () => {
    const render = renderSlackIntent({
      kind: "summary_card",
      title: "No actions here",
    });
    expect(render.blocks).toHaveLength(1);
    expect(render.blocks?.[0].type).toBe("section");
  });

  it("derives a non-empty fallback text covering title, subtitle, body, fields", () => {
    const render = renderSlackIntent(intent);
    expect(render.text).toBe(
      [
        "Add feature flag",
        "example/repo#42",
        "Introduces a new flag for rolling out v2.",
        "Author: octocat",
        "Status: Open",
      ].join("\n"),
    );
  });

  it("escapes <, >, and & in title, subtitle, body field labels", () => {
    const render = renderSlackIntent({
      fields: [{ label: "A<b>", value: "x&y" }],
      kind: "summary_card",
      subtitle: "<sub>",
      title: "A & B <c>",
    });
    const section = render.blocks?.[0];
    const sectionText =
      section && "text" in section ? (section.text?.text ?? "") : "";
    expect(sectionText).toContain("A &amp; B &lt;c&gt;");
    expect(sectionText).toContain("&lt;sub&gt;");
    const fields = section && "fields" in section ? section.fields : undefined;
    expect(fields?.[0].text).toBe("*A&lt;b&gt;*\nx&amp;y");
  });
});

describe("renderSlackIntent - alert", () => {
  it("prefixes title with severity emoji and emits section + actions", () => {
    const render = renderSlackIntent({
      actions: [{ label: "Investigate", url: "https://example.com" }],
      body: "Latency spiked above threshold.",
      kind: "alert",
      severity: "warning",
      title: "High p95 latency",
    });
    expect(render.blocks).toBeDefined();
    const [section] = render.blocks!;
    const text = "text" in section && section.text ? section.text.text : "";
    expect(text.startsWith(":warning: ")).toBe(true);
    expect(text).toContain("*High p95 latency*");
    expect(render.text.startsWith("[WARNING]")).toBe(true);
  });
});

describe("renderSlackIntent - comparison_table", () => {
  it("renders header + rows inline and derives a | separated fallback", () => {
    const render = renderSlackIntent({
      columns: ["Metric", "Before", "After"],
      kind: "comparison_table",
      rows: [
        ["p50", "120ms", "90ms"],
        ["p95", "800ms", "400ms"],
      ],
      title: "Latency",
    });
    expect(render.blocks).toHaveLength(1);
    expect(render.text).toContain("Metric | Before | After");
    expect(render.text).toContain("p50 | 120ms | 90ms");
  });
});

describe("renderSlackIntent - result_carousel", () => {
  it("emits header + dividers between items, preserves url links", () => {
    const render = renderSlackIntent({
      items: [
        {
          subtitle: "repo#1",
          title: "First",
          url: "https://example.com/1",
        },
        {
          title: "Second",
        },
      ],
      kind: "result_carousel",
      title: "Matching results",
    });
    const blocks = render.blocks ?? [];
    expect(blocks[0].type).toBe("header");
    expect(blocks.filter((b) => b.type === "divider")).toHaveLength(1);
    const firstItemSection = blocks[1];
    const text =
      "text" in firstItemSection && firstItemSection.text
        ? firstItemSection.text.text
        : "";
    expect(text).toContain("<https://example.com/1|First>");
  });
});

describe("renderSlackIntent - progress_plan", () => {
  it("renders tasks with status icons and a non-empty fallback", () => {
    const render = renderSlackIntent({
      kind: "progress_plan",
      tasks: [
        { id: "a", status: "complete", title: "Fetch data" },
        { id: "b", status: "in_progress", title: "Render summary" },
        { id: "c", status: "pending", title: "Post to channel" },
      ],
      title: "Replying to issue 42",
    });
    const section = render.blocks?.[0];
    const text =
      section && "text" in section && section.text ? section.text.text : "";
    expect(text).toContain(":white_check_mark: Fetch data");
    expect(text).toContain(":hourglass_flowing_sand: Render summary");
    expect(text).toContain(":black_square_button: Post to channel");
    expect(render.text).toContain("[in_progress] Render summary");
  });
});

describe("renderIntentFallbackText", () => {
  it("returns the same text as renderSlackIntent for every intent kind", () => {
    const intents: SlackRenderIntent[] = [
      { kind: "plain_reply", text: "hi" },
      { kind: "summary_card", title: "T" },
      { kind: "alert", severity: "info", title: "T" },
      {
        columns: ["a", "b"],
        kind: "comparison_table",
        rows: [["1", "2"]],
      },
      { items: [{ title: "one" }], kind: "result_carousel" },
      {
        kind: "progress_plan",
        tasks: [{ id: "x", status: "pending", title: "t" }],
        title: "T",
      },
    ];
    for (const intent of intents) {
      const fromRender = renderSlackIntent(intent).text;
      const fromHelper = renderIntentFallbackText(intent);
      expect(fromHelper).toBe(fromRender);
      expect(fromHelper.length).toBeGreaterThan(0);
    }
  });
});
