import { describe, expect, it, vi } from "vitest";
import { vercelPlugin } from "../src";

const sha = "a".repeat(40);
const deployment = {
  id: "dpl_example",
  url: "example.vercel.app",
  readyState: "READY",
  target: null,
  projectId: "prj_example",
  gitSource: { sha, ref: "feature/test" },
  env: { PRIVATE: "secret" },
};
const options = { toolCallId: "action" };
function fixture(...responses: Response[]) {
  const fetch = vi.fn();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return {
    fetch,
    tools: vercelPlugin().hooks!.tools!({ egress: { fetch } } as never),
  };
}

describe("Vercel actions", () => {
  it("deploys any linked project with Preview default or explicit Production", async () => {
    for (const target of [undefined, "preview", "production"] as const) {
      const project = {
        id: "prj_other",
        name: "other-app",
        link: { type: "github", repoId: 456 },
      };
      const { tools, fetch } = fixture(
        Response.json(project),
        Response.json({
          ...deployment,
          target: target === "production" ? "production" : null,
        }),
      );
      const result = await tools.deploymentCreate.execute?.(
        {
          project: "other-app",
          team: "another-team",
          ref: "feature/test",
          commitSha: sha,
          target,
        },
        options,
      );
      expect(fetch.mock.calls[0][0].request.url).toBe(
        "https://api.vercel.com/v9/projects/other-app?slug=another-team",
      );
      const call = fetch.mock.calls[1][0];
      expect(call.operation).toBe("vercel.deployment.create");
      expect(call.request.method).toBe("POST");
      const body = await call.request.json();
      expect(body).toEqual({
        name: project.name,
        project: project.id,
        target: target === "production" ? "production" : undefined,
        gitSource: { type: "github", repoId: 456, ref: "feature/test", sha },
      });
      expect(Object.hasOwn(body, "target")).toBe(target === "production");
      expect(result).toMatchObject({
        objectAnnotations: [
          {
            kind: "object",
            objectType: "item",
            displayType: "Deployment",
            facts: {
              type: "deployment",
              project: "prj_example",
              revision: sha,
              branch: "feature/test",
            },
          },
        ],
        deploymentId: deployment.id,
        commitSha: sha,
        url: "https://example.vercel.app",
      });
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(result).not.toHaveProperty("env");
    }
  });

  it("inspects deployments and detects a changed alias after assignment without retrying", async () => {
    const { tools, fetch } = fixture(
      Response.json(deployment),
      Response.json({ alias: "qa.example.com" }),
      Response.json({ alias: "qa.example.com", deploymentId: "dpl_other" }),
    );
    await expect(
      tools.deploymentInspect.execute?.(
        { deployment: deployment.id, team: "team_example" },
        options,
      ),
    ).resolves.toMatchObject({ state: "READY", deploymentId: deployment.id });
    await expect(
      tools.aliasAssign.execute?.(
        {
          deploymentId: deployment.id,
          alias: "qa.example.com",
          team: "team_example",
        },
        options,
      ),
    ).resolves.toMatchObject({ matches: false, deploymentId: "dpl_other" });
    const assignment = fetch.mock.calls[1][0].request;
    expect(assignment.url).toBe(
      `https://api.vercel.com/v2/deployments/${deployment.id}/aliases?teamId=team_example`,
    );
    expect(await assignment.json()).toEqual({ alias: "qa.example.com" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("reads redirects and deletes an exact deployment in the requested team", async () => {
    const { tools, fetch } = fixture(
      Response.json({
        alias: "www.example.com",
        deploymentId: null,
        redirect: "example.com",
      }),
      new Response(null, { status: 204 }),
    );
    await expect(
      tools.aliasInspect.execute?.({ alias: "www.example.com" }, options),
    ).resolves.toMatchObject({ redirect: "example.com", deploymentId: null });
    await expect(
      tools.deploymentDelete.execute?.(
        { deploymentId: deployment.id, team: "team_other" },
        options,
      ),
    ).resolves.toMatchObject({ deleted: true, deploymentId: deployment.id });
    expect(fetch.mock.calls[1][0].request).toMatchObject({
      method: "DELETE",
      url: `https://api.vercel.com/v13/deployments/${deployment.id}?teamId=team_other`,
    });
  });

  it("reports unsupported sources and invalid targets as repairable errors", async () => {
    const { tools, fetch } = fixture(
      Response.json({
        id: "prj_other",
        name: "other",
        link: { type: "gitlab", projectId: 456 },
      }),
    );
    await expect(
      tools.deploymentCreate.execute?.({ project: "other", ref: sha }, options),
    ).rejects.toMatchObject({ name: "PluginToolInputError" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const missing = fixture(
      new Response("private provider details", { status: 404 }),
    );
    await expect(
      missing.tools.aliasInspect.execute?.(
        { alias: "missing.example.com" },
        options,
      ),
    ).rejects.toMatchObject({
      name: "PluginToolInputError",
      message: "vercel.alias.get failed with HTTP 404",
    });
  });

  it("does not retry uncertain writes or expose raw error payloads", async () => {
    const { tools, fetch } = fixture(
      new Response("private provider details", { status: 500 }),
    );
    await expect(
      tools.deploymentDelete.execute?.(
        { deploymentId: deployment.id },
        options,
      ),
    ).rejects.toThrow("vercel.deployment.delete failed with HTTP 500");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
