import { afterEach, describe, expect, it, vi } from "vitest";

import {
  agentNamePossessive,
  getDashboardAgentName,
} from "../src/client/agentName";

afterEach(() => vi.unstubAllGlobals());

describe("dashboard agent name", () => {
  it("defaults to Junior outside the browser", () => {
    expect(getDashboardAgentName()).toBe("Junior");
    expect(agentNamePossessive()).toBe("Junior's");
  });

  it("reads the configured shell value without mutable client state", () => {
    vi.stubGlobal("window", {
      __JUNIOR_DASHBOARD_AGENT_NAME__: "Marky",
    });

    expect(getDashboardAgentName()).toBe("Marky");
    expect(agentNamePossessive()).toBe("Marky's");
  });

  it("handles names ending in s", () => {
    expect(agentNamePossessive("Atlas")).toBe("Atlas'");
  });
});
