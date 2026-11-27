import { describe, expect, it } from "vitest";
import { decide } from "@/chat/guardian/agent/guardian";
import { ASK_RULES, DENY_RULES } from "@/chat/guardian/agent/policy";
import type { Action } from "@/chat/guardian/guardian";
import { renderAction, renderMessages } from "@/chat/guardian/agent/render";

const RULES = ["none", ...ASK_RULES, ...DENY_RULES] as const;

/** Every advice that core can give Guardian. */
const ACTIONS = [
  {},
  { advice: { decision: "allow", reason: "Only the PR text changes." } },
] as const satisfies readonly Pick<Action, "advice">[];

function isDeny(rule: (typeof RULES)[number]): boolean {
  return DENY_RULES.some((deny) => deny === rule);
}

/** The decision order of `design/guardian.md`, written out case by case. */
function expected(
  rule: (typeof RULES)[number],
  action: Pick<Action, "advice">,
): "allow" | "ask" | "deny" {
  if (rule === "none") return "allow";
  if (isDeny(rule)) return "deny";
  return rule === "unrequested" && action.advice ? "allow" : "ask";
}

describe("agent Guardian decide", () => {
  it("decides every rule and advice in the design's order", () => {
    const wrong = RULES.flatMap((rule) =>
      ACTIONS.filter(
        (action) =>
          decide({ rule, reason: "r" }, action).decision !==
          expected(rule, action),
      ).map((action) => ({ rule, action })),
    );
    expect(wrong).toEqual([]);
  });

  it("always denies a deny rule", () => {
    for (const rule of DENY_RULES) {
      for (const action of ACTIONS) {
        expect(decide({ rule, reason: "r" }, action)).toEqual({
          decision: "deny",
          rule,
          reason: "r",
        });
      }
    }
  });

  it("keeps the rule and both reasons when advice allows", () => {
    expect(
      decide({ rule: "unrequested", reason: "Nobody asked." }, ACTIONS[1]),
    ).toEqual({
      decision: "allow",
      rule: "unrequested",
      reason: "Only the PR text changes. Nobody asked.",
    });
  });

  it("lets advice change only `unrequested`", () => {
    const changed = RULES.filter(
      (rule) =>
        decide({ rule, reason: "r" }, ACTIONS[1]).decision !==
        decide({ rule, reason: "r" }, ACTIONS[0]).decision,
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
        summary: "Create a gist.",
        target: { ref: "gist-1", audience: "world" },
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
      { tool: "bash", input: { command: "git push" } },
      sandbox,
      false,
    );
    const other = renderAction(
      { tool: "createGist", input: {} },
      sandbox,
      false,
    );

    expect(bash).toContain('"env":"GITHUB_TOKEN"');
    expect(other).not.toContain("GITHUB_TOKEN");
  });
});
