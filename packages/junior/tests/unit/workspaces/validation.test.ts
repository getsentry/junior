import { describe, expect, it } from "vitest";
import {
  normalizeWorkspaceRecipe,
  WorkspaceValidationError,
} from "@/chat/workspaces/validation";

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
            isPrimary: true,
          },
        ],
      }),
    ).toEqual({
      name: "sentry",
      setupScript: "pnpm install",
      repos: [
        {
          provider: "github",
          repo: "getsentry/sentry",
          isPrimary: true,
        },
      ],
    });
  });

  it("requires one primary repository when repos exist", () => {
    expect(() =>
      normalizeWorkspaceRecipe({
        name: "sentry",
        repos: [{ provider: "github", repo: "getsentry/sentry" }],
      }),
    ).toThrow(WorkspaceValidationError);
  });

  it("rejects checkout path collisions", () => {
    expect(() =>
      normalizeWorkspaceRecipe({
        name: "sentry",
        repos: [
          {
            provider: "github",
            repo: "getsentry/sentry",
            isPrimary: true,
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
      repos: [],
    });
  });
});
