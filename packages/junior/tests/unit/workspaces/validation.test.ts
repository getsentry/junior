import { describe, expect, it } from "vitest";
import { normalizeWorkspaceRecipe } from "@/chat/workspaces/validation";

describe("normalizeWorkspaceRecipe", () => {
  it("normalizes names and providers", () => {
    expect(
      normalizeWorkspaceRecipe({
        name: " Sentry ",
        setupScript: "pnpm install",
        repos: [
          {
            provider: " GitHub ",
            repo: " getsentry/sentry ",
          },
        ],
      }),
    ).toEqual({
      name: "sentry",
      setupScript: "pnpm install",
      prebuild: false,
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
        },
      ],
    });
  });

  it("allows repositories without a primary selection", () => {
    expect(
      normalizeWorkspaceRecipe({
        name: "sentry",
        repos: [
          { provider: "github", repo: "getsentry/sentry" },
          { provider: "github", repo: "getsentry/relay" },
        ],
      }),
    ).toEqual({
      name: "sentry",
      setupScript: "",
      prebuild: false,
      repos: [
        { provider: "github", repo: "getsentry/sentry" },
        { provider: "github", repo: "getsentry/relay" },
      ],
    });
  });

  it("rejects checkout path collisions", () => {
    expect(() =>
      normalizeWorkspaceRecipe({
        name: "sentry",
        repos: [
          {
            provider: "github",
            repo: "getsentry/sentry",
          },
          {
            provider: "github",
            repo: "acme/sentry",
          },
        ],
      }),
    ).toThrow(/checkout path collision/i);
  });

  it("allows empty repository lists", () => {
    expect(
      normalizeWorkspaceRecipe({
        name: "empty",
        repos: [],
      }),
    ).toEqual({
      name: "empty",
      setupScript: "",
      prebuild: false,
      repos: [],
    });
  });
});
