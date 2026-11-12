/**
 * Isolated harness for the model call that writes a pull request
 * description from the context that the agent passes to the GitHub PR tools.
 *
 * Calls the real `writePullRequestDescription` with the host decision and plugin models
 * that the GitHub plugin gets. It does not run the agent, GitHub, Postgres,
 * or Redis.
 */
import {
  createHarness,
  type DescribeEvalOptions,
  type JsonValue,
} from "vitest-evals";
import { botConfig } from "@/chat/config";
import { createPluginDecider, createPluginModel } from "@/chat/plugins/model";
import { writePullRequestDescription } from "../../../junior-github/src/tool-support/pull-request-description";

interface PullRequestDescriptionEvalInput {
  /** What the agent passes as `description_context`. */
  context: string;
  /** Exact text, such as issue references and links, that must stay. */
  mustInclude?: string[];
  /** Exact text, such as secrets and mentions, that must not appear. */
  mustNotInclude?: string[];
  /** Longest allowed description, for notes that reviewers called too long. */
  maxChars?: number;
  /** True: the notes leave out a fact a reviewer needs. False: the notes are complete, so any gap is noise. */
  expectGaps?: boolean;
  title?: string;
}

interface PullRequestDescriptionEvalOutput extends Record<string, JsonValue> {
  description: string;
  gaps: string[];
}

// The runtime appends attribution and the footer, and the workflow rules
// keep check results out of the description.
const FORBIDDEN = [
  {
    name: "an attribution or footer",
    pattern: /junior-(?:request-attribution|session-footer)|View Session/i,
  },
  {
    name: "a checks section",
    pattern: /^\s*(?:#+\s*|\*\*)(?:checks|verification|test plan|testing)\b/im,
  },
];

/** Lightweight vitest-evals harness for PR description cases. */
export const pullRequestDescriptionHarness = createHarness<
  PullRequestDescriptionEvalInput,
  PullRequestDescriptionEvalOutput
>({
  name: "pull-request-description",
  run: async ({ input }) => {
    const { description, gaps } = await writePullRequestDescription(
      {
        decider: createPluginDecider("github"),
        model: createPluginModel("github"),
      },
      {
        context: input.context,
        repo: "getsentry/junior",
        ...(input.title ? { title: input.title } : undefined),
      },
    );
    const problems = [
      ...(description ? [] : ["is empty"]),
      ...FORBIDDEN.filter(({ pattern }) => pattern.test(description)).map(
        ({ name }) => `has ${name}`,
      ),
      ...(input.mustInclude ?? [])
        .filter((text) => !description.includes(text))
        .map((text) => `dropped "${text}"`),
      ...(input.mustNotInclude ?? [])
        .filter((text) => description.includes(text))
        .map((text) => `kept "${text}"`),
      ...(input.maxChars && description.length > input.maxChars
        ? [`is ${description.length} characters, over ${input.maxChars}`]
        : []),
      ...(input.expectGaps === true && gaps.length === 0
        ? ["reported no gaps"]
        : []),
      ...(input.expectGaps === false && gaps.length > 0
        ? [`reported gaps for complete notes (${gaps.join(" | ")})`]
        : []),
    ];
    if (problems.length > 0) {
      throw new Error(`Description ${problems.join("; ")}:\n${description}`);
    }
    return {
      output: { description, gaps },
      events: [
        {
          type: "message",
          role: "user",
          content: [input.title ? `Title: ${input.title}` : "", input.context]
            .filter(Boolean)
            .join("\n\n"),
        },
        { type: "message", role: "assistant", content: description },
      ],
      usage: { provider: "vercel-ai-gateway", model: botConfig.fastModelId },
    };
  },
});

/** Shared vitest-evals suite options for PR description evals. */
export const pullRequestDescriptionEvals = {
  harness: pullRequestDescriptionHarness,
  // The harness checks the fixed rules. Each case asks the rubric judge.
  judges: [],
  judgeThreshold: null,
} satisfies DescribeEvalOptions<
  PullRequestDescriptionEvalInput,
  PullRequestDescriptionEvalOutput,
  typeof pullRequestDescriptionHarness
>;
