import { describe, expect, it } from "vitest";
import { normalizeWorkspaceRecipe } from "@/chat/workspaces/validation";

describe("normalizeWorkspaceRecipe", () => {
  it("normalizes names and providers", () => {
    expect(
      normalizeWorkspaceRecipe({
        name: " Sentry ",
        setupScript: "pnpm install",
        vcpus: 8,
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
      vcpus: 8,
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
      vcpus: null,
      repos: [
        { provider: "github", repo: "getsentry/sentry" },
        { provider: "github", repo: "getsentry/relay" },
      ],
    });
  });

  it("rejects vCPUs that are not positive integers", () => {
    for (const vcpus of [0, -2, 1.5]) {
      expect(() =>
        normalizeWorkspaceRecipe({ name: "sentry", vcpus, repos: [] }),
      ).toThrow("vCPUs must be a positive integer.");
    }
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
      vcpus: null,
      repos: [],
    });
  });
});
