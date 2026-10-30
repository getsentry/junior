import { describe, expect, it } from "vitest";
import { linearPlugin } from "../../../../junior-linear/src/index.js";
import { serviceAccountAllows } from "@/chat/credentials/service-account";
import { parseInlinePluginManifest } from "@/chat/plugins/manifest";

describe("Linear plugin package", () => {
  it("lets the optional service account call only read tools", () => {
    const registration = linearPlugin();
    const manifest = parseInlinePluginManifest(
      {
        ...registration.manifest,
        configKeys: registration.manifest.configKeys ?? [],
      },
      "/plugins/linear",
    );

    const tools = manifest.accounts?.serviceAccount?.tools ?? [];
    expect(manifest.accounts?.userOAuth).toBeUndefined();
    expect(
      tools.filter((tool) => !/^(get|list|search|extract)_/.test(tool)),
    ).toEqual([]);
    expect(serviceAccountAllows(manifest, { tool: "get_issue" })).toBe(true);
    expect(serviceAccountAllows(manifest, { tool: "save_issue" })).toBe(false);
  });
});
