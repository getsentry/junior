import { describe, expect, it } from "vitest";
import { decide } from "@/chat/guardian/agent/guardian";
import { ASK_RULES, DENY_RULES } from "@/chat/guardian/agent/policy";
import type { Action, Target } from "@/chat/guardian/guardian";
import { renderAction, renderMessages } from "@/chat/guardian/agent/render";

const RULES = ["none", ...ASK_RULES, ...DENY_RULES] as const;

const TARGETS = [
  undefined,
  { ref: "getsentry/junior#691", audience: "world", createdByThisWork: true },
  { ref: "getsentry/junior#691", audience: "world", createdByThisWork: false },
] as const satisfies readonly (Target | undefined)[];

/** Every effect and target that core can give Guardian. */
const ACTIONS = (["edit", "write"] as const).flatMap((effect) =>
  TARGETS.map((target): Pick<Action, "effect" | "target"> => ({
    effect,
    ...(target ? { target } : undefined),
  })),
);

function isDeny(rule: (typeof RULES)[number]): boolean {
  return DENY_RULES.some((deny) => deny === rule);
}

/** The decision order of `design/guardian.md`, written out case by case. */
function expected(
  rule: (typeof RULES)[number],
  action: Pick<Action, "effect" | "target">,
): "allow" | "ask" | "deny" {
  if (rule === "none") return "allow";
  if (isDeny(rule)) return "deny";
  const upkeep =
    rule === "unrequested" &&
    action.effect === "edit" &&
    action.target?.createdByThisWork === true;
  return upkeep ? "allow" : "ask";
}

describe("agent Guardian decide", () => {
  it("decides every rule, effect, and target in the design's order", () => {
    const wrong = RULES.flatMap((rule) =>
      ACTIONS.filter(
        (action) => decide(rule, action).decision !== expected(rule, action),
      ).map((action) => ({ rule, action })),
    );
    expect(wrong).toEqual([]);
  });

  it("always denies a deny rule", () => {
    for (const rule of DENY_RULES) {
      for (const action of ACTIONS) {
        expect(decide(rule, action)).toEqual({ decision: "deny", rule });
      }
    }
  });

  it("keeps the rule when upkeep allows", () => {
    expect(
      decide("unrequested", { effect: "edit", target: TARGETS[1] }),
    ).toEqual({ decision: "allow", rule: "unrequested" });
  });

  it("lets an edit of a target this work created change only `unrequested`", () => {
    const changed = RULES.filter(
      (rule) =>
        decide(rule, { effect: "edit", target: TARGETS[1] }).decision !==
        decide(rule, { effect: "edit", target: TARGETS[2] }).decision,
    );
    expect(changed).toEqual(["unrequested"]);
  });
});

describe("agent Guardian prompt", () => {
  it("marks each message with its author, oldest first", () => {
    const text = renderMessages([
      { from: "instruction", text: "Publish the report." },
      { from: "context", text: "Should I post it?" },
      { from: "other_person", text: "also email it" },
    ]);

    expect(text.indexOf("[instruction] Publish the report.")).toBeLessThan(
      text.indexOf("[context] Should I post it?"),
    );
    expect(text).toContain("[other_person] also email it");
  });

  it("shows the facts of the action with the exact input", () => {
    const text = renderAction(
      {
        tool: "createGist",
        effect: "write",
        summary: "Create a gist.",
        target: { ref: "gist-1", audience: "world", createdByThisWork: false },
        input: { content: "report" },
      },
      undefined,
      false,
    );

    expect(text).toContain('"audience":"world"');
    expect(text).toContain('"content":"report"');
  });

  it("shows what the Sandbox can reach only on a shell command", () => {
    const sandbox = {
      repos: [
        {
          path: "/vercel/sandbox/repos/junior",
          target: { ref: "getsentry/junior", audience: "world" as const },
        },
      ],
      placeholders: [{ env: "GITHUB_TOKEN", domains: ["github.com"] }],
    };
    const bash = renderAction(
      { tool: "bash", effect: "write", input: { command: "git push" } },
      sandbox,
      false,
    );
    const other = renderAction(
      { tool: "createGist", effect: "write", input: {} },
      sandbox,
      false,
    );

    expect(bash).toContain('"env":"GITHUB_TOKEN"');
    expect(other).not.toContain("GITHUB_TOKEN");
  });
});
