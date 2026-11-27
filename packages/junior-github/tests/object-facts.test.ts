import { afterEach, describe, expect, it, vi } from "vitest";
import { githubObjectFacts } from "../src/object-facts";

/** The facts that the live card of this GitHub pull request response shows. */
function cardFacts(pullRequest: Record<string, unknown>) {
  const { facts } = githubObjectFacts("code_change", {
    base: { ref: "main" },
    draft: false,
    head: { ref: "feat/events" },
    html_url: "https://github.com/getsentry/junior/pull/691",
    merged: false,
    number: 691,
    state: "open",
    title: "Updated title",
    ...pullRequest,
  });
  if (facts?.type !== "code_change") throw new Error("No change facts.");
  return facts;
}

describe("GitHub card facts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("shows the artifact and GitHub attachment images as previews", () => {
    vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
    const artifact =
      "https://junior.example.com/public/artifacts/0123456789abcdef.png";
    const after =
      "https://junior.example.com/public/artifacts/fedcba9876543210.png";
    const attachment =
      "https://github.com/user-attachments/assets/0f8c2d6e-5a4b-4c3d-9e8f-7a6b5c4d3e2f";
    const body = [
      "![Unknown](https://github.com/user-attachments/assets/1)",
      // A signed attachment URL expires in minutes.
      "![Signed](https://private-user-images.githubusercontent.com/1/2.png?jwt=signed)",
      `![Attachment](${attachment})`,
      "![Other](https://example.com/public/artifacts/0123456789abcdef.png)",
      "```md",
      "![Example](https://junior.example.com/public/artifacts/code.png)",
      "```",
      // A `src=` inside another attribute value is not the image.
      `| Before | After |\n| --- | --- |\n| ![Before][before] | <img alt=" src=https://junior.example.com/public/artifacts/alt.png" src="${after}"> |`,
      `![Again](${artifact})`,
      "",
      `[before]: ${artifact}`,
    ].join("\n");

    expect(
      cardFacts({
        body,
        user: { login: "alex" },
        requested_reviewers: [{ login: "sam" }],
        changed_files: 8,
        additions: 120,
        deletions: 30,
      }),
    ).toEqual({
      type: "code_change",
      author: "alex",
      reviewers: ["sam"],
      sourceBranch: "feat/events",
      targetBranch: "main",
      changedFiles: 8,
      additions: 120,
      deletions: 30,
      previewImageUrls: [attachment, artifact, after],
    });
    for (const other of [
      "![Private](https://github.com/user-attachments/assets/1)",
      "No image.",
    ]) {
      expect(cardFacts({ body: other })).not.toHaveProperty("previewImageUrls");
    }
  });

  it("shows as many preview images as fit in the facts limit", () => {
    vi.stubEnv("JUNIOR_BASE_URL", "https://junior.example.com");
    const images = Array.from(
      { length: 80 },
      (_, index) =>
        `https://junior.example.com/public/artifacts/${String(index).padStart(16, "0")}.png`,
    );

    const facts = cardFacts({
      body: images.map((url) => `![Step](${url})`).join("\n"),
      // 180 extra UTF-8 bytes, more than one image entry, so counting
      // characters instead of bytes would save one image too many.
      user: { login: "ü".repeat(60) },
      head: { ref: "ü".repeat(60) },
      base: { ref: "ü".repeat(60) },
    });
    const saved = facts.previewImageUrls ?? [];

    const bytes = (value: unknown) =>
      new TextEncoder().encode(JSON.stringify(value)).length;

    // More than the old fixed 4, in body order, and the next one would not fit.
    expect(saved.length).toBeGreaterThan(4);
    expect(saved).toEqual(images.slice(0, saved.length));
    expect(bytes(facts)).toBeLessThanOrEqual(4096);
    expect(
      bytes({ ...facts, previewImageUrls: images.slice(0, saved.length + 1) }),
    ).toBeGreaterThan(4096);
  });
});
