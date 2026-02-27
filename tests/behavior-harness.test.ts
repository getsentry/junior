import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertBehaviorEvalCase, loadBehaviorEvalSuite } from "../evals/behavior-harness";

describe("behavior harness", () => {
  it("rejects invalid suite schema with a precise path", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "behavior-eval-"));
    const suitePath = path.join(tmpDir, "invalid.yaml");
    fs.writeFileSync(
      suitePath,
      [
        'schema_version: "1.0"',
        "name: invalid suite",
        "cases:",
        "  - id: broken",
        '    description: "missing expected"',
        "    events:",
        "      - type: new_mention",
        "        thread:",
        "          id: t1",
        "        message:",
        '          text: "hello"'
      ].join("\n")
    );

    expect(() => loadBehaviorEvalSuite(suitePath)).toThrowError(
      /Invalid behavior eval suite at cases\.0\.expected/
    );
  });

  it("assertions fail with diagnostics when expectations are wrong", () => {
    const testCase = {
      id: "bad_expectation_case",
      description: "Produces one post but expects two",
      events: [],
      expected: {
        posts_count: 2
      }
    };

    const result = {
      logs: [],
      posts: ["one reply"],
      sandboxIds: [],
      warnings: [],
      exceptions: [],
      primaryThread: undefined,
      slackAdapter: {
        titleCalls: [],
        promptCalls: [],
        setAssistantTitle: async () => undefined,
        setSuggestedPrompts: async () => undefined
      },
      toolCalls: []
    };

    expect(() => assertBehaviorEvalCase(testCase, result)).toThrowError(
      /expected posts_count=2 but got 1.*posts=.*warnings=.*exceptions=/
    );
  });
});
