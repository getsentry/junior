import { describe, expect, it } from "vitest";
import { decide } from "@/chat/guardian/agent/guardian";
import {
  AGENT_GUARDIAN_POLICY,
  ASK_RULES,
  DENY_RULES,
} from "@/chat/guardian/agent/policy";
import type { Action } from "@/chat/guardian/guardian";
import { renderAction, renderMessages } from "@/chat/guardian/agent/render";

const RULES = ["none", ...ASK_RULES, ...DENY_RULES] as const;
type RuleId = (typeof RULES)[number];

/** Every decision that a tool's own `guardian` can give. */
const ACTIONS = [
  {},
  { toolDecision: { decision: "allow", reason: "own-pr-text" } },
  { toolDecision: { decision: "ask", reason: "public-team" } },
  { toolDecision: { decision: "deny" } },
] as const satisfies readonly Pick<Action, "toolDecision">[];

function isDeny(rule: RuleId): boolean {
  return DENY_RULES.some((deny) => deny === rule);
}

/** The decision order of `design/guardian.md`, written out case by case. */
function expected(
  rule: RuleId,
  action: Pick<Action, "toolDecision">,
  confirmed: boolean,
): "allow" | "ask" | "deny" {
  const tool = action.toolDecision?.decision;
  if (isDeny(rule) || tool === "deny") return "deny";
  if (confirmed) return "allow";
  if (tool === "ask") return "ask";
  if (rule === "none") return "allow";
  return rule === "unrequested" && tool === "allow" ? "allow" : "ask";
}

describe("agent Guardian decide", () => {
  it("decides every rule and tool decision in the design's order", () => {
    const wrong = RULES.flatMap((rule) =>
      ACTIONS.flatMap((action) =>
        [false, true]
          .filter(
            (confirmed) =>
              decide({ rule, reason: "r", confirmed }, action).decision !==
              expected(rule, action, confirmed),
          )
          .map((confirmed) => ({ rule, action, confirmed })),
      ),
    );
    expect(wrong).toEqual([]);
  });

  it("never lets a yes clear a deny, and holds a tool's ask without one", () => {
    const outcomes = RULES.flatMap((rule) =>
      ACTIONS.flatMap((action: Pick<Action, "toolDecision">) =>
        [false, true].map((confirmed) => ({
          rule,
          tool: action.toolDecision?.decision,
          confirmed,
          decision: decide({ rule, reason: "r", confirmed }, action).decision,
        })),
      ),
    );
    expect(
      outcomes.filter(
        (o) => (isDeny(o.rule) || o.tool === "deny") && o.decision !== "deny",
      ),
    ).toEqual([]);
    expect(
      outcomes.filter(
        (o) =>
          o.tool === "ask" &&
          !o.confirmed &&
          !isDeny(o.rule) &&
          o.decision !== "ask",
      ),
    ).toEqual([]);
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
      reason: "Tool: allow (own-pr-text). Nobody asked.",
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
      reason: "Tool: ask (public-team). r",
    });
    expect(
      decide({ rule: "none", reason: "r", confirmed: true }, ACTIONS[2])
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

  it("leaves out facts that repeat or contradict what code knows", () => {
    const text = renderAction(
      {
        tool: "mcp__linear__save_issue",
        summary: "mcp__linear__save_issue",
        target: { ref: "Linear team PY", audience: "world" },
        toolDecision: { decision: "ask", reason: "public-team" },
        serverHints: { openWorldHint: false },
        input: { team: "PY" },
      },
      undefined,
      false,
    );
    const bash = renderAction(
      { tool: "bash", input: { command: "git push" } },
      { placeholders: [] },
      false,
    );

    expect(text).not.toContain('"summary"');
    expect(text).not.toContain("untrustedServerHints");
    expect(text).toContain('"reason":"public-team"');
    expect(bash).not.toContain("placeholders");
  });

  it("shows what the Sandbox can reach only on a shell command", () => {
    const sandbox = {
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

  it("shows plugin context as its own block that never clears a deny or a hold", () => {
    const text = renderAction(
      {
        tool: "bash",
        input: { command: "git push origin fix/x" },
        context: [
          "[github] The agent's work branch in getsentry/junior: fix/x",
        ],
      },
      undefined,
      false,
    );

    expect(text).toContain(
      "<plugin-context>\n[github] The agent's work branch in getsentry/junior: fix/x\n</plugin-context>",
    );
    expect(AGENT_GUARDIAN_POLICY).toContain(
      "It never clears a deny rule or a person's restriction.",
    );
  });
});
