import { describe, expect, it } from "vitest";
import { githubPlugin } from "../src/index";
import { gitHubCloneRepositoryTool } from "../src/tools/clone-repository";
import { guardianContext } from "./plugin-harness";

describe("GitHub checkout targets", () => {
  const checkout = (repo: string, visibility?: { private: boolean }) =>
    githubPlugin().hooks!.guardian!(
      { kind: "workspaceCheckout", repo },
      guardianContext(visibility ? { visibility } : {}),
    );

  it("gives a Workspace checkout its clone URL and visibility", async () => {
    await expect(
      checkout("getsentry/junior", { private: false }),
    ).resolves.toEqual({
      target: "https://github.com/getsentry/junior.git",
      audience: "world",
    });
    await expect(checkout("acme/atlas", { private: true })).resolves.toEqual({
      target: "https://github.com/acme/atlas.git",
      audience: "internal",
    });
  });

  it("counts a repository that GitHub does not answer for as world", async () => {
    await expect(checkout("acme/atlas")).resolves.toEqual({
      target: "https://github.com/acme/atlas.git",
      audience: "world",
    });
  });

  it("gives a clone the same target as a Workspace checkout", async () => {
    await expect(
      gitHubCloneRepositoryTool.guardian?.(
        { repo: "acme/atlas" },
        guardianContext({ visibility: { private: true } }),
      ),
    ).resolves.toEqual({
      target: "https://github.com/acme/atlas.git",
      audience: "internal",
    });
  });
});
