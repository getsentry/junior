import { describe, expect, it } from "vitest";
import { createWebSource } from "@sentry/junior-plugin-api";
import { deriveVisibleMemoryScopes } from "../src/scope";

describe("deriveVisibleMemoryScopes", () => {
  it("unions actor/source scopes with linked identity scopes", () => {
    const scopes = deriveVisibleMemoryScopes({
      actor: {
        platform: "web",
        userId: "dashboard:alice",
        email: "alice@example.com",
      },
      identities: [
        {
          id: "identity:junior:alice@example.com",
          provider: "junior",
          providerSubjectId: "alice@example.com",
        },
        {
          id: "identity:slack:T123:U123",
          provider: "slack",
          providerSubjectId: "U123",
          providerTenantId: "T123",
        },
        {
          id: "identity:slack:T999:U999",
          provider: "slack",
          providerSubjectId: "U999",
          providerTenantId: "T999",
        },
      ],
      source: createWebSource("local:web:alice", "public"),
    });

    expect(scopes).toEqual(
      expect.arrayContaining([
        { scope: "personal", scopeKey: "junior:alice@example.com" },
        { scope: "conversation", scopeKey: "local:web:alice" },
        { scope: "conversation", scopeKey: "slack:T123" },
        { scope: "conversation", scopeKey: "slack:T999" },
        { scope: "personal", scopeKey: "slack:T123:U123" },
        { scope: "personal", scopeKey: "slack:T999:U999" },
      ]),
    );
    expect(scopes).toHaveLength(6);
  });
});
