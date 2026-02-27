import { describe, expect, it } from "vitest";
import { createChannelConfigurationService } from "@/chat/configuration/service";

function createInMemoryService() {
  let state: Record<string, unknown> | null = null;
  const service = createChannelConfigurationService({
    load: async () => state,
    save: async (next) => {
      state = {
        ...(state ?? {}),
        configuration: next
      };
    }
  });
  return {
    service,
    getState: () => state
  };
}

describe("channel configuration service", () => {
  it("sets, gets, lists, resolves, and unsets entries", async () => {
    const { service, getState } = createInMemoryService();

    const created = await service.set({
      key: "github.repo",
      value: "getsentry/junior",
      updatedBy: "U123",
      source: "test"
    });
    expect(created.key).toBe("github.repo");
    expect(created.scope).toBe("channel");
    expect(created.updatedBy).toBe("U123");
    expect(created.source).toBe("test");

    const fetched = await service.get("github.repo");
    expect(fetched?.value).toBe("getsentry/junior");

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.key).toBe("github.repo");

    await service.set({
      key: "jira.project",
      value: "PLAT"
    });
    const prefixed = await service.list({ prefix: "github." });
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0]?.key).toBe("github.repo");

    await expect(service.resolve("github.repo")).resolves.toBe("getsentry/junior");
    await expect(service.resolveValues()).resolves.toEqual({
      "github.repo": "getsentry/junior",
      "jira.project": "PLAT"
    });
    await expect(service.resolveValues({ keys: ["jira.project"] })).resolves.toEqual({
      "jira.project": "PLAT"
    });

    await expect(service.unset("github.repo")).resolves.toBe(true);
    await expect(service.unset("github.repo")).resolves.toBe(false);
    await expect(service.get("github.repo")).resolves.toBeUndefined();

    expect(getState()).toEqual({
      configuration: {
        schemaVersion: 1,
        entries: {
          "jira.project": expect.objectContaining({
            key: "jira.project",
            value: "PLAT",
            scope: "channel"
          })
        }
      }
    });
  });

  it("rejects invalid keys and secret-like values", async () => {
    const { service } = createInMemoryService();

    await expect(
      service.set({
        key: "token.value",
        value: "abc"
      })
    ).rejects.toThrow("secret-related");

    await expect(
      service.set({
        key: "github.repo",
        value: "Bearer abcdefghijklmnopqrstuvwxyz123456"
      })
    ).rejects.toThrow("secret material");
  });
});
