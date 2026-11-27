import { describe, expect, it } from "vitest";
import { decide } from "@/chat/guardian/agent/guardian";
import { ASK_RULES, DENY_RULES } from "@/chat/guardian/agent/policy";
import type { Action } from "@/chat/guardian/guardian";
import { renderAction, renderMessages } from "@/chat/guardian/agent/render";

const RULES = ["none", ...ASK_RULES, ...DENY_RULES] as const;
type RuleId = (typeof RULES)[number];

/** Every decision that a tool's own `guardian` can give. */
const ACTIONS = [
  {},
  { toolDecision: { decision: "allow", reason: "Only the PR text changes." } },
  { toolDecision: { decision: "ask", reason: "A public team." } },
  { toolDecision: { decision: "deny" } },
] as const satisfies readonly Pick<Action, "toolDecision">[];

function isDeny(rule: RuleId): boolean {
  return DENY_RULES.some((deny) => deny === rule);
}

/** The decision order of `design/guardian.md`, written out case by case. */
function expected(
  rule: RuleId,
  action: Pick<Action, "toolDecision">,
  personSaidYes: boolean,
): "allow" | "ask" | "deny" {
  const tool = action.toolDecision?.decision;
  if (isDeny(rule) || tool === "deny") return "deny";
  if (tool === "ask" && !personSaidYes) return "ask";
  if (rule === "none") return "allow";
  return rule === "unrequested" && tool === "allow" ? "allow" : "ask";
}

describe("agent Guardian decide", () => {
  it("decides every rule and tool decision in the design's order", () => {
    const wrong = RULES.flatMap((rule) =>
      ACTIONS.flatMap((action) =>
        [false, true]
          .filter(
            (personSaidYes) =>
              decide({ rule, reason: "r", personSaidYes }, action).decision !==
              expected(rule, action, personSaidYes),
          )
          .map((personSaidYes) => ({ rule, action, personSaidYes })),
      ),
    );
    expect(wrong).toEqual([]);
  });

  it("always denies a deny rule", () => {
    for (const rule of DENY_RULES) {
      expect(decide({ rule, reason: "r" }, {})).toEqual({
        decision: "deny",
        rule,
        reason: "r",
      });
    }
  });

  it("keeps the rule and both reasons when the tool allows", () => {
    expect(
      decide({ rule: "unrequested", reason: "Nobody asked." }, ACTIONS[1]),
    ).toEqual({
      decision: "allow",
      rule: "unrequested",
      reason: "Tool: allow. Only the PR text changes. Nobody asked.",
    });
  });

  it("lets the tool's allow change only `unrequested`", () => {
    const changed = RULES.filter(
      (rule) =>
        decide({ rule, reason: "r" }, ACTIONS[1]).decision !==
        decide({ rule, reason: "r" }, ACTIONS[0]).decision,
    );
    expect(changed).toEqual(["unrequested"]);
  });

  it("holds the tool's ask until the person says yes", () => {
    expect(decide({ rule: "none", reason: "r" }, ACTIONS[2])).toEqual({
      decision: "ask",
      reason: "Tool: ask. A public team. r",
    });
    expect(
      decide({ rule: "none", reason: "r", personSaidYes: true }, ACTIONS[2])
        .decision,
    ).toBe("allow");
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
          remotes: [{ ref: "getsentry/junior", audience: "world" as const }],
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
