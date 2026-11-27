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

  it("gives each team write the audience of its team", async () => {
    const registration = linearPlugin({ publicTeams: ["PY"] });
    const tools = registration.hooks!.guardian!.tools!;
    const guardian = (tool: string, input: Record<string, unknown>) =>
      tools[tool]!(input, {} as never);
    const manifest = parseInlinePluginManifest(
      {
        ...registration.manifest,
        configKeys: registration.manifest.configKeys ?? [],
      },
      "/plugins/linear",
    );

    expect(manifest.reviewContext).toContain("Linear teams PY sync");
    await expect(
      guardian("save_issue", { team: "PY", title: "x" }),
    ).resolves.toEqual({ target: "Linear team PY", audience: "world" });
    await expect(
      guardian("save_comment", { issueId: "WEB-12" }),
    ).resolves.toEqual({ target: "Linear team WEB", audience: "internal" });
    // A team name or a UUID could be a public team.
    await expect(
      guardian("save_issue", { team: "Python SDK", title: "x" }),
    ).resolves.toEqual({ target: "Linear Python SDK", audience: "world" });
    await expect(guardian("save_issue", { id: "6f1c-uuid" })).resolves.toEqual({
      target: "Linear 6f1c-uuid",
      audience: "world",
    });
    // A read has no entry, so it keeps the manifest default.
    expect(Object.keys(tools)).toEqual(["save_issue", "save_comment"]);
  });
});
