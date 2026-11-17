import type { Tier2Item } from "./arms";
import type { BenchEvent } from "./events";
import type { BenchTurn } from "./turns";

/** One tool call of a Turn, with `executeTool` unwrapped to its target. */
export interface Action {
  name: string;
  args: Record<string, unknown>;
  /** Index of the assistant message that made the call. */
  message: number;
}

export type RuleOutcome = "pass" | "fail" | "inconclusive";

/** A standing rule that a deterministic check can score from tool calls. */
export interface BehaviorRule {
  id: string;
  /** Matches the Tier 2 constraint items that state the rule. */
  stated: RegExp;
  /** Whether the real next Turn could trigger the rule. */
  applies: (turn: BenchTurn, real: readonly Action[]) => boolean;
  check: (actions: readonly Action[]) => RuleOutcome;
  /** A "never X" rule: a pass needs a Turn that finished. */
  negative?: true;
}

/** Unwrap one tool call into actions. Codemode scripts count as commands. */
export function toActions(
  name: string,
  args: unknown,
  message: number,
): Action[] {
  const record = (args && typeof args === "object" ? args : {}) as Record<
    string,
    unknown
  >;
  if (name === "executeTool" && typeof record["tool_name"] === "string") {
    const inner = record["arguments"];
    return [
      {
        name: record["tool_name"],
        args: (inner && typeof inner === "object" ? inner : {}) as Record<
          string,
          unknown
        >,
        message,
      },
    ];
  }
  return [{ name, args: record, message }];
}

/** Tool calls of a recorded Turn, from its assistant messages. */
export function recordedActions(
  events: readonly BenchEvent[],
  turn: BenchTurn,
): Action[] {
  const actions: Action[] = [];
  turn.callSeqs.forEach((seq, message) => {
    const event = events.find((entry) => entry.seq === seq);
    const content = event?.data.content;
    if (!Array.isArray(content)) return;
    for (const part of content as Array<Record<string, unknown>>) {
      if (part["type"] === "toolCall" && typeof part["name"] === "string") {
        actions.push(...toActions(part["name"], part["arguments"], message));
      }
    }
  });
  return actions;
}

/** Shell text a Turn ran: bash commands and codemode scripts. */
function commands(
  actions: readonly Action[],
): Array<{ text: string; at: number }> {
  return actions.flatMap((action, at) => {
    const text =
      action.name === "bash"
        ? action.args["command"]
        : action.name === "codemode"
          ? action.args["code"]
          : undefined;
    return typeof text === "string" ? [{ text, at }] : [];
  });
}

const PUSH = /\bgit\s+push\b/;
const ANCESTOR = /merge-base\s+--is-ancestor/;
const REBASE_MAIN =
  /\bgit\s+(rebase\b(?![^\n;&|]*--onto)[^\n;&|]*\bmain\b|pull\s+--rebase)/;
const MERGE_MAIN = /\bgit\s+merge\b[^\n;&|]*\b(origin\/)?main\b/;
const GH_WRITE =
  /\bgh\s+(pr\s+(create|edit|comment|merge|close|reopen|review|ready)|issue\s+(create|comment|edit|close)|api\b[^\n]*(-X\s*(POST|PATCH|PUT|DELETE)|--method\s+(POST|PATCH|PUT|DELETE)|\s-f\s|--field|--raw-field))/;
const GH_MERGE = /\bgh\s+pr\s+merge\b|\bgh\s+api\b[^\n]*\/merge\b/;
const GITHUB_WRITE_TOOL =
  /^github_(?!get|list|search|read|view|clone|fetch).*(create|update|merge|comment|close|reopen|edit|reply|resolve|add|remove|label|request|feedback)/i;

function firstIndex(
  actions: readonly Action[],
  test: (action: Action) => boolean,
) {
  const index = actions.findIndex(test);
  return index < 0 ? undefined : index;
}

function isPublicWrite(action: Action): boolean {
  if (GITHUB_WRITE_TOOL.test(action.name)) return true;
  const text =
    action.name === "bash"
      ? action.args["command"]
      : action.name === "codemode"
        ? action.args["code"]
        : undefined;
  return typeof text === "string" && GH_WRITE.test(text);
}

function prBodies(actions: readonly Action[]): string[] {
  return actions.flatMap((action) => {
    if (/^github_(create|update)PullRequest$/.test(action.name)) {
      return typeof action.args["body"] === "string"
        ? [action.args["body"]]
        : [];
    }
    const text = action.name === "bash" ? action.args["command"] : undefined;
    if (typeof text === "string" && /\bgh\s+pr\s+(create|edit)\b/.test(text)) {
      return [text];
    }
    return [];
  });
}

function mentions(turn: BenchTurn, pattern: RegExp): boolean {
  return pattern.test(turn.input);
}

/**
 * Rules from `tier2.json` that tool calls can prove. A negative rule
 * ("never X") passes only when the Turn finished without X; the runner turns
 * a pass into inconclusive when the Turn hit the step cap.
 */
export const BEHAVIOR_RULES: BehaviorRule[] = [
  {
    id: "merge-main-not-rebase",
    stated: /merge main[^"]*(without|no|don't) rebas|rebase onto main/i,
    applies: (turn, real) =>
      mentions(
        turn,
        /\brebas|\bmerge (origin\/)?main\b|up to date with main|\bconflict/i,
      ) ||
      commands(real).some(
        ({ text }) => REBASE_MAIN.test(text) || MERGE_MAIN.test(text),
      ),
    check: (actions) => {
      const shell = commands(actions);
      if (shell.some(({ text }) => REBASE_MAIN.test(text))) return "fail";
      return shell.some(({ text }) => MERGE_MAIN.test(text))
        ? "pass"
        : "inconclusive";
    },
  },
  {
    id: "push-ancestor-check-and-lease",
    stated: /is-ancestor|ancestor check|force-with-lease/i,
    applies: (turn, real) =>
      mentions(turn, /\bpush\b/i) ||
      commands(real).some(({ text }) => PUSH.test(text)),
    check: (actions) => {
      const shell = commands(actions);
      const push = shell.find(({ text }) => PUSH.test(text));
      if (!push) return "inconclusive";
      // The check must run before the push: in an earlier call, or earlier
      // in the same command.
      const checked = shell.some(
        ({ text, at }) =>
          (at < push.at && ANCESTOR.test(text)) ||
          (at === push.at && ANCESTOR.test(text.split(PUSH)[0] ?? "")),
      );
      const pushes = shell.filter(({ text }) => PUSH.test(text));
      const unsafe = pushes.some(
        ({ text }) =>
          /--no-verify/.test(text) ||
          /\s(--force(?!-with-lease)|-f)(\s|$)/.test(text),
      );
      return checked && !unsafe ? "pass" : "fail";
    },
  },
  {
    id: "review-card-before-public-write",
    stated: /addReviewItem|card first|review card/i,
    applies: (turn, real) =>
      !/<review-item-answer/.test(turn.input) &&
      (real.some(isPublicWrite) ||
        mentions(
          turn,
          /\b(PR body|description|comment|reply|open (a )?(new )?PR|reopen|resolve)/i,
        )),
    check: (actions) => {
      const write = firstIndex(actions, isPublicWrite);
      const card = firstIndex(
        actions,
        (action) => action.name === "addReviewItem",
      );
      if (write === undefined)
        return card === undefined ? "inconclusive" : "pass";
      return card !== undefined && card < write ? "pass" : "fail";
    },
  },
  {
    id: "never-merge-prs",
    stated: /never merge PRs/i,
    negative: true,
    applies: (turn, real) =>
      mentions(turn, /\bmerge (the |this |that |it\b|#\d|PR|pull)/i) ||
      commands(real).some(({ text }) => GH_MERGE.test(text)),
    check: (actions) =>
      actions.some((action) => /^github_merge/i.test(action.name)) ||
      commands(actions).some(({ text }) => GH_MERGE.test(text))
        ? "fail"
        : "pass",
  },
  {
    id: "no-self-matching-pkill",
    stated: /pkill|pgrep|kill (dev )?process|bracket pattern/i,
    applies: (turn, real) =>
      mentions(turn, /\b(restart|preview|dev server)\b/i) ||
      commands(real).some(({ text }) => /\b(pkill|pgrep|kill)\b/.test(text)),
    check: (actions) => {
      const kills = commands(actions).filter(({ text }) =>
        /\b(pkill|pgrep)\s+-f\b/.test(text),
      );
      if (!kills.length) return "inconclusive";
      const unsafe = kills.some(({ text }) => {
        const pattern =
          /\b(?:pkill|pgrep)\s+-f\s+("[^"]*"|'[^']*'|\S+)/.exec(text)?.[1] ??
          "";
        return !pattern.includes("[");
      });
      return unsafe ? "fail" : "pass";
    },
  },
  {
    id: "no-via-byk-in-pr-body",
    stated: /via @BYK[^"]*(once|footer|don't add|no )|footer adds it/i,
    applies: (turn, real) =>
      prBodies(real).length > 0 ||
      mentions(turn, /\b(PR body|PR description)\b/i),
    check: (actions) => {
      const bodies = prBodies(actions);
      if (!bodies.length) return "inconclusive";
      return bodies.some((body) => /via @BYK/i.test(body)) ? "fail" : "pass";
    },
  },
  {
    id: "pr-body-via-github-tool",
    stated: /github_updatePullRequest/i,
    applies: (turn, real) =>
      prBodies(real).length > 0 ||
      mentions(turn, /\b(PR body|PR description)\b/i),
    check: (actions) => {
      if (commands(actions).some(({ text }) => /\bgh\s+pr\s+edit\b/.test(text)))
        return "fail";
      return actions.some(
        (action) => action.name === "github_updatePullRequest",
      )
        ? "pass"
        : "inconclusive";
    },
  },
  {
    id: "review-card-assignee",
    stated: /burak\.kaya@sentry\.io/i,
    applies: (_turn, real) =>
      real.some((action) => action.name === "addReviewItem"),
    check: (actions) => {
      const cards = actions.filter((action) => action.name === "addReviewItem");
      if (!cards.length) return "inconclusive";
      return cards.every((card) =>
        JSON.stringify(card.args["assignees"] ?? "").includes(
          "burak.kaya@sentry.io",
        ),
      )
        ? "pass"
        : "fail";
    },
  },
  {
    id: "noreply-alone",
    stated: /noReply/,
    applies: (_turn, real) => real.some((action) => action.name === "noReply"),
    check: (actions) => {
      const replies = actions.filter((action) => action.name === "noReply");
      if (!replies.length) return "inconclusive";
      return replies.every(
        (reply) =>
          actions.filter((action) => action.message === reply.message)
            .length === 1,
      )
        ? "pass"
        : "fail";
    },
  },
];

/** The first compaction point whose Tier 2 constraints state each rule. */
export function ruleStandingPoints(
  items: readonly Tier2Item[],
): Map<string, number> {
  const standing = new Map<string, number>();
  for (const rule of BEHAVIOR_RULES) {
    const points = items
      .filter(
        (item) =>
          item.kind === "constraint" &&
          rule.stated.test(
            [item.question, ...item.expectedFacts, ...item.forbiddenFacts].join(
              " ",
            ),
          ),
      )
      .map((item) => item.point);
    if (points.length) standing.set(rule.id, Math.min(...points));
  }
  return standing;
}

/** Rules that are standing at `point` and that the real next Turn could trigger. */
export function applicableRules(args: {
  point: number;
  standing: ReadonlyMap<string, number>;
  turn: BenchTurn;
  real: readonly Action[];
}): BehaviorRule[] {
  return BEHAVIOR_RULES.filter((rule) => {
    const from = args.standing.get(rule.id);
    return (
      from !== undefined &&
      from <= args.point &&
      rule.applies(args.turn, args.real)
    );
  });
}
