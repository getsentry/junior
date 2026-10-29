import { describe, expect, it } from "vitest";
import {
  buildEventIdentifier,
  eventIdentifierSchema,
  parseEventIdentifier,
} from "@sentry/junior-plugin-api";

const PART = { kind: "string", description: "part" } as const;

// A commit needs a target, so the commit group is inside the target group.
const deployment = eventIdentifierSchema.parse({
  template: "{projectId}[:{target}[:{commitSha}]]",
  parts: {
    projectId: PART,
    target: { ...PART, enum: ["preview", "production"] },
    commitSha: { kind: "hex", description: "commit" },
  },
});

describe("event identifiers", () => {
  it("reads and writes each optional reading of a template", () => {
    for (const identifier of ["prj_1", "prj_1:preview", "prj_1:preview:abc1"]) {
      const parsed = parseEventIdentifier(deployment, identifier);
      expect(
        parsed.ok && buildEventIdentifier(deployment, parsed.parts),
      ).toEqual({ ok: true, identifier });
    }
    expect(parseEventIdentifier(deployment, "prj_1:abc1")).toEqual({
      ok: false,
      problems: [
        {
          part: "target",
          message:
            '"target" cannot be "abc1". Use one of: "preview", "production".',
        },
      ],
    });
  });

  it("names each wrong or missing part when it builds", () => {
    expect(
      buildEventIdentifier(deployment, {
        projectId: "prj 1",
        commitSha: "abc1",
      }),
    ).toEqual({
      ok: false,
      problems: [
        { part: "projectId", message: '"projectId" cannot contain spaces.' },
        {
          part: "target",
          message: 'Give a value for "target" too, or leave "commitSha" empty.',
        },
      ],
    });
    // Reserved separators stay out of every part, so one string has one reading.
    expect(buildEventIdentifier(deployment, { projectId: "a#b" })).toEqual({
      ok: false,
      problems: [
        { part: "projectId", message: '"projectId" cannot contain "#".' },
      ],
    });
  });

  it("rejects a template that has more than one reading of a string", () => {
    const issues = (template: string) => {
      const result = eventIdentifierSchema.safeParse({
        template,
        parts: { owner: PART, repo: PART },
      });
      return result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
    };

    expect(issues("{owner}/{repo}")).toEqual([]);
    expect(issues("{owner}{repo}")).toEqual([
      "Template parts {owner} and {repo} need text between them.",
    ]);
    expect(issues("{owner}x{repo}")).toEqual([
      'Template part {owner} must be followed by punctuation, such as "/" or ":".',
    ]);
    expect(issues("{owner}/{repo}[:{tag}]")).toEqual([
      "Template part {tag} is not in parts.",
    ]);
    expect(issues("{owner}")).toEqual(['Part "repo" is not in the template.']);
  });
});
