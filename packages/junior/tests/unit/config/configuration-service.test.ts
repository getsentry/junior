import { describe, expect, it } from "vitest";
import { createLocationConfigurationService } from "@/chat/configuration/service";
import type { ConfigEntry } from "@/chat/configuration/types";

function createInMemoryService() {
  const entries = new Map<string, ConfigEntry>();
  const service = createLocationConfigurationService({
    get: async (key) => entries.get(key),
    list: async () => [...entries.values()],
    set: async (entry) => {
      entries.set(entry.key, entry);
    },
    unset: async (key) => entries.delete(key),
  });
  return { service, entries };
}

describe("location configuration service", () => {
  it("sets, gets, lists, resolves, and unsets entries", async () => {
    const { service, entries } = createInMemoryService();

    const created = await service.set({
      key: "github.repo",
      value: "getsentry/junior",
      updatedBy: "U123",
      source: "test",
    });
    expect(created).toMatchObject({
      key: "github.repo",
      scope: "location",
      updatedBy: "U123",
      source: "test",
    });
    await expect(service.get("github.repo")).resolves.toMatchObject({
      value: "getsentry/junior",
    });
    await expect(service.list()).resolves.toHaveLength(1);

    await service.set({ key: "jira.project", value: "PLAT" });
    await expect(service.list({ prefix: "github." })).resolves.toHaveLength(1);
    await expect(service.resolve("github.repo")).resolves.toBe(
      "getsentry/junior",
    );
    await expect(service.resolveValues()).resolves.toEqual({
      "github.repo": "getsentry/junior",
      "jira.project": "PLAT",
    });
    await expect(
      service.resolveValues({ keys: ["jira.project"] }),
    ).resolves.toEqual({ "jira.project": "PLAT" });

    await expect(service.unset("github.repo")).resolves.toBe(true);
    await expect(service.unset("github.repo")).resolves.toBe(false);
    expect(entries.has("github.repo")).toBe(false);
  });

  it("rejects invalid keys and secret-like values", async () => {
    const { service } = createInMemoryService();
    await expect(
      service.set({ key: "token.value", value: "abc" }),
    ).rejects.toThrow("secret-related");
    await expect(
      service.set({
        key: "github.repo",
        value: "Bearer abcdefghijklmnopqrstuvwxyz123456",
      }),
    ).rejects.toThrow("secret material");
  });
});
