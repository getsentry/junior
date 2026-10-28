import { describe, expect, it, vi } from "vitest";
import type { LocationConfigurationService } from "@/chat/configuration/types";
import { maybeApplyProviderDefaultConfigRequest } from "@/chat/services/provider-default-config";

function locationConfiguration() {
  const set = vi.fn<LocationConfigurationService["set"]>();
  const service: LocationConfigurationService = {
    get: vi.fn(),
    set,
    unset: vi.fn(),
    list: vi.fn(),
    resolve: vi.fn(),
    resolveValues: vi.fn(),
  };
  return { set, service };
}

describe("maybeApplyProviderDefaultConfigRequest", () => {
  it.each([
    "Set the default repo to getsentry/junior.",
    "use the default GitHub repository as getsentry/junior for this channel",
  ])("stores the repo of an explicit request: %s", async (text) => {
    const { service, set } = locationConfiguration();

    await expect(
      maybeApplyProviderDefaultConfigRequest({
        locationConfiguration: service,
        actorId: "U0TESTER",
        text,
      }),
    ).resolves.toEqual({
      text: "Default GitHub repo set to `getsentry/junior`.",
    });
    expect(set).toHaveBeenCalledWith({
      key: "github.repo",
      value: "getsentry/junior",
      updatedBy: "U0TESTER",
      source: "provider-default-config",
    });
  });

  it("leaves a request that also asks for other work to the agent", async () => {
    const { service, set } = locationConfiguration();

    await expect(
      maybeApplyProviderDefaultConfigRequest({
        locationConfiguration: service,
        text: "Set the default repo to getsentry/junior and create an issue for flaky evals.",
      }),
    ).resolves.toBeNull();
    expect(set).not.toHaveBeenCalled();
  });
});
