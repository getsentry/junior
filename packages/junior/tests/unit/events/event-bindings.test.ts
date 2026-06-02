import { describe, expect, it } from "vitest";
import {
  parseAndValidateEventBindingFiles,
  parseEventBindingFile,
  validateEventBindings,
  type ParsedEventBinding,
} from "@/chat/events/bindings";
import type { RegisteredAgentEventDefinition } from "@/chat/plugins/agent-hooks";

const definitions: RegisteredAgentEventDefinition[] = [
  {
    event: "github.pull_request.comment.created",
    plugin: "github",
    definition: {
      contextBlocks: {
        source_comment: { description: "Triggering GitHub comment" },
        pull_request: { description: "GitHub pull request metadata" },
      },
      deliveryTargets: [{ target: "source_thread" }],
    },
  },
];

function bindingMarkdown(frontmatter: string[], body = "Review the event.") {
  return ["---", ...frontmatter, "---", "", body].join("\n");
}

describe("event binding files", () => {
  it("parses frontmatter and prompt body from Markdown", () => {
    const parsed = parseEventBindingFile({
      path: "/repo/app/events/github/warden.md",
      raw: bindingMarkdown([
        "id: github-warden-pr-comment",
        "event: github.pull_request.comment.created",
        "scope:",
        "  repository: getsentry/junior",
        "when:",
        "  actor: sentry-warden[bot]",
        "context:",
        "  include:",
        "    - source_comment",
        "    - pull_request",
        "delivery:",
        "  target: source_thread",
      ]),
    });

    expect(parsed).toEqual({
      ok: true,
      binding: {
        id: "github-warden-pr-comment",
        event: "github.pull_request.comment.created",
        enabled: true,
        path: "/repo/app/events/github/warden.md",
        body: "Review the event.",
        scope: { repository: "getsentry/junior" },
        when: { actor: "sentry-warden[bot]" },
        contextInclude: ["source_comment", "pull_request"],
        delivery: { target: "source_thread" },
      },
    });
  });

  it("rejects unknown frontmatter fields instead of silently ignoring them", () => {
    const parsed = parseEventBindingFile({
      path: "/repo/app/events/github/typo.md",
      raw: bindingMarkdown([
        "id: github-typo",
        "event: github.pull_request.comment.created",
        "delivrey:",
        "  target: source_thread",
      ]),
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      throw new Error("expected event binding parse to fail");
    }
    expect(parsed.error).toContain("Unrecognized key");
  });

  it("validates bindings against event definitions", () => {
    const binding: ParsedEventBinding = {
      id: "github-warden-pr-comment",
      event: "github.pull_request.comment.created",
      enabled: true,
      path: "/repo/app/events/github/warden.md",
      body: "Review the event.",
      contextInclude: ["source_comment"],
      delivery: { target: "source_thread" },
    };

    expect(validateEventBindings([binding], definitions)).toEqual({
      bindings: [binding],
      errors: [],
    });
  });

  it("rejects duplicate context blocks and unsupported selectors", () => {
    const duplicateContext: ParsedEventBinding = {
      id: "github-duplicate-context",
      event: "github.pull_request.comment.created",
      enabled: true,
      path: "/repo/app/events/github/duplicate-context.md",
      body: "Review the event.",
      contextInclude: ["source_comment", "source_comment"],
    };
    const unsupportedScope: ParsedEventBinding = {
      id: "github-unsupported-scope",
      event: "github.pull_request.comment.created",
      enabled: true,
      path: "/repo/app/events/github/unsupported-scope.md",
      body: "Review the event.",
      contextInclude: [],
      scope: { repository: "getsentry/junior" },
    };

    expect(
      validateEventBindings([duplicateContext, unsupportedScope], definitions)
        .errors,
    ).toEqual([
      '/repo/app/events/github/duplicate-context.md: event binding "github-duplicate-context" includes duplicate context block "source_comment"',
      '/repo/app/events/github/unsupported-scope.md: event binding "github-unsupported-scope" uses scope fields but event "github.pull_request.comment.created" does not support scope selectors',
    ]);
  });

  it("rejects runtime policy overrides until they are enforced", () => {
    const base: ParsedEventBinding = {
      id: "github-policy",
      event: "github.pull_request.comment.created",
      enabled: true,
      path: "/repo/app/events/github/policy.md",
      body: "Review the event.",
      contextInclude: [],
    };

    expect(
      validateEventBindings(
        [{ ...base, tools: { allow: ["github.comments.write"] } }],
        definitions,
      ).errors,
    ).toEqual([
      '/repo/app/events/github/policy.md: event binding "github-policy" uses tools, but event prompt tool policy overrides are not supported yet',
    ]);

    expect(
      validateEventBindings(
        [{ ...base, constraints: { requireDraftPullRequest: true } }],
        definitions,
      ).errors,
    ).toEqual([
      '/repo/app/events/github/policy.md: event binding "github-policy" uses constraints, but event prompt constraint overrides are not supported yet',
    ]);

    expect(
      validateEventBindings(
        [{ ...base, limits: { maxToolCalls: 10 } }],
        definitions,
      ).errors,
    ).toEqual([
      '/repo/app/events/github/policy.md: event binding "github-policy" uses limits, but event prompt limit overrides are not supported yet',
    ]);
  });

  it("returns parse and validation errors without dropping valid bindings", () => {
    const result = parseAndValidateEventBindingFiles(
      [
        {
          path: "/repo/app/events/github/valid.md",
          raw: bindingMarkdown([
            "id: github-valid",
            "event: github.pull_request.comment.created",
            "context:",
            "  include:",
            "    - source_comment",
            "delivery:",
            "  target: source_thread",
          ]),
        },
        {
          path: "/repo/app/events/github/unknown-context.md",
          raw: bindingMarkdown([
            "id: github-unknown-context",
            "event: github.pull_request.comment.created",
            "context:",
            "  include:",
            "    - missing_context",
          ]),
        },
        {
          path: "/repo/app/events/github/missing-frontmatter.md",
          raw: "Review the event.",
        },
      ],
      definitions,
    );

    expect(result.bindings.map((binding) => binding.id)).toEqual([
      "github-valid",
      "github-unknown-context",
    ]);
    expect(result.errors).toEqual([
      "/repo/app/events/github/missing-frontmatter.md: missing YAML frontmatter",
      '/repo/app/events/github/unknown-context.md: event binding "github-unknown-context" references unsupported context block "missing_context" for event "github.pull_request.comment.created"',
    ]);
  });

  it("rejects duplicate binding ids", () => {
    const left: ParsedEventBinding = {
      id: "github-warden",
      event: "github.pull_request.comment.created",
      enabled: true,
      path: "/repo/app/events/github/left.md",
      body: "Review the event.",
      contextInclude: [],
    };
    const right: ParsedEventBinding = {
      ...left,
      path: "/repo/app/events/github/right.md",
    };

    expect(validateEventBindings([left, right], definitions).errors).toEqual([
      '/repo/app/events/github/right.md: duplicate event binding id "github-warden" already declared in /repo/app/events/github/left.md',
    ]);
  });
});
