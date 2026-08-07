import { describe, expect, it } from "vitest";

import { findTranscriptMarkdownLinks } from "../src/client/conversations/transcriptMarkdownLinks";

describe("transcript markdown links", () => {
  it("finds safe markdown links, bare links, and skips unsafe destinations", () => {
    const text =
      'See [trace](https://sentry.example/trace), https://docs.example/path)., [local](/api/me), [titled](https://docs.example/titled "Docs"), and [bad](javascript:https://unsafe.example).';

    expect(findTranscriptMarkdownLinks(text)).toEqual([
      {
        end: 41,
        href: "https://sentry.example/trace",
        label: "trace",
        start: 4,
      },
      {
        end: 68,
        href: "https://docs.example/path",
        label: "https://docs.example/path",
        start: 43,
      },
      {
        end: 134,
        href: "https://docs.example/titled",
        label: "titled",
        start: 90,
      },
    ]);
  });

  it("renders CommonMark autolinks without their angle-bracket syntax", () => {
    const text =
      "See <https://docs.example/path> and <mailto:team@example.com>, but keep `<https://literal.example>` literal.";

    expect(findTranscriptMarkdownLinks(text)).toEqual([
      {
        end: 31,
        href: "https://docs.example/path",
        label: "https://docs.example/path",
        start: 4,
      },
      {
        end: 61,
        href: "mailto:team@example.com",
        label: "mailto:team@example.com",
        start: 36,
      },
    ]);
  });

  it("renders bare-email CommonMark autolinks that stringifyMarkdown emits", () => {
    // mdast emits mailto links whose label matches the address as <user@host>,
    // not <mailto:user@host>. Package-ish emails still round-trip this way.
    const text =
      "Ping <team@example.com> or <vitest-evals@0.16.1> after the release.";

    expect(findTranscriptMarkdownLinks(text)).toEqual([
      {
        end: 23,
        href: "mailto:team@example.com",
        label: "team@example.com",
        start: 5,
      },
      {
        end: 48,
        href: "mailto:vitest-evals@0.16.1",
        label: "vitest-evals@0.16.1",
        start: 27,
      },
    ]);
  });

  it("does not let malformed nested labels swallow later valid links", () => {
    const text = "See [broken [real](https://nested.example/ok).";

    expect(findTranscriptMarkdownLinks(text)).toEqual([
      {
        end: 45,
        href: "https://nested.example/ok",
        label: "real",
        start: 12,
      },
    ]);
  });

  it("leaves markdown-looking links inside inline code alone", () => {
    const text =
      "Use `[syntax](https://example.com)` and ``https://bare.example`` before [real](https://real.example) plus https://bare-real.example.";

    expect(
      findTranscriptMarkdownLinks(text).map(({ href, label }) => ({
        href,
        label,
      })),
    ).toEqual([
      {
        href: "https://real.example",
        label: "real",
      },
      {
        href: "https://bare-real.example",
        label: "https://bare-real.example",
      },
    ]);
  });

  it("leaves escaped markdown links literal", () => {
    const text =
      "Keep \\[literal](https://literal.example) but link [real](https://real.example).";

    expect(
      findTranscriptMarkdownLinks(text).map(({ href, label }) => ({
        href,
        label,
      })),
    ).toEqual([
      {
        href: "https://real.example",
        label: "real",
      },
    ]);
  });

  it("does not autolink bare URLs inside ignored markdown destinations", () => {
    const text =
      "Ignore [local](/api/internal/https://internal.example), [bad](javascript:https://unsafe.example), and keep https://safe.example.";

    expect(
      findTranscriptMarkdownLinks(text).map(({ href, label }) => ({
        href,
        label,
      })),
    ).toEqual([
      {
        href: "https://safe.example",
        label: "https://safe.example",
      },
    ]);
  });
});
