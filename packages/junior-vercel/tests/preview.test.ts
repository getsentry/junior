import { afterEach, describe, expect, it, vi } from "vitest";
import { vercelPlugin } from "../src/index";
import {
  issueVercelCredential,
  vercelGrantForEgress,
} from "../src/credentials";
import { createVercelPreviewTools } from "../src/tools/preview";
import type {
  PluginEgress,
  PluginEgressRequest,
  ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";

const scope = {
  teamId: "team_example",
  projectId: "prj_example",
  repository: "getsentry/junior",
  alias: "junior-qa.example.com",
};
const sha = "a".repeat(40);
const project = {
  id: scope.projectId,
  name: "junior-example",
  link: { type: "github", org: "getsentry", repo: "junior", repoId: 123 },
};
const preview = {
  id: "dpl_example",
  projectId: scope.projectId,
  readyState: "READY",
  target: null,
  url: "preview.example.com",
  gitSource: { type: "github", sha, repoId: 123 },
};
const identity = { deploymentId: preview.id, commitSha: sha };
const options = { toolCallId: "preview" };

function fixture() {
  vi.stubEnv("JUNIOR_VERCEL_TOKEN", "read-token");
  vi.stubEnv("JUNIOR_VERCEL_PREVIEW_TOKEN", "write-token");
  const upstream = vi.fn(
    async (
      request: Request | string,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(typeof request === "string" ? request : request.url);
      const method =
        typeof request === "string" ? (init?.method ?? "GET") : request.method;
      if (url.pathname.startsWith("/v9/projects/"))
        return Response.json(project);
      if (url.pathname.startsWith("/v4/aliases/"))
        return Response.json({ deploymentId: preview.id });
      if (method === "DELETE") return new Response(null, { status: 204 });
      if (method === "POST" && url.pathname.endsWith("/aliases"))
        return Response.json({ alias: scope.alias });
      return Response.json(preview);
    },
  );
  vi.stubGlobal("fetch", upstream);
  const egress: PluginEgress = {
    async fetch(input) {
      const grant = await vercelGrantForEgress(
        {
          method: input.request.method,
          url: input.request.url,
          operation: input.operation,
          bodyText: input.request.body
            ? await input.request.clone().text()
            : undefined,
        },
        scope,
      );
      const credential = issueVercelCredential(grant, scope);
      expect(credential.type).toBe("lease");
      return upstream(input.request);
    },
  };
  return {
    upstream,
    tools: createVercelPreviewTools(
      { egress } as ToolRegistrationHookContext,
      scope,
    ),
  };
}

function createRequest(
  patch: Record<string, unknown> = {},
): PluginEgressRequest {
  return {
    method: "POST",
    operation: "vercel.preview.create",
    url: `https://api.vercel.com/v13/deployments?teamId=${scope.teamId}`,
    bodyText: JSON.stringify({
      name: project.name,
      project: scope.projectId,
      target: "preview",
      gitSource: {
        type: "github",
        org: "getsentry",
        repo: "junior",
        ref: sha,
        sha,
      },
      ...patch,
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Vercel Preview actions", () => {
  it("builds, selects, checks, and explicitly deletes a scoped Preview", async () => {
    const { tools, upstream } = fixture();
    await expect(
      tools.preview_create.execute?.({ commitSha: sha }, options),
    ).resolves.toMatchObject({ target: "preview", ...identity });
    const create = upstream.mock.calls
      .map(([request]) => request)
      .find(
        (request) => request instanceof Request && request.method === "POST",
      ) as Request;
    expect(await create.json()).toEqual({
      name: project.name,
      project: scope.projectId,
      target: "preview",
      gitSource: {
        type: "github",
        org: "getsentry",
        repo: "junior",
        ref: sha,
        sha,
      },
    });
    await expect(
      tools.preview_select.execute?.(
        { ...identity, commitSha: "b".repeat(40) },
        options,
      ),
    ).rejects.toThrow("configured Preview project and commit");
    await expect(
      tools.preview_select.execute?.(identity, options),
    ).resolves.toMatchObject({ alias: scope.alias, aliasMatches: true });
    await expect(
      tools.preview_inspect.execute?.(identity, options),
    ).resolves.toMatchObject({ aliasMatches: true });
    await expect(
      tools.preview_delete.execute?.(identity, options),
    ).resolves.toMatchObject({ state: "DELETED" });
    expect(
      upstream.mock.calls.filter(
        ([request]) =>
          request instanceof Request && request.method === "DELETE",
      ),
    ).toHaveLength(1);
  });

  it("reports a moved alias without writing it back", async () => {
    const { tools, upstream } = fixture();
    upstream
      .mockResolvedValueOnce(Response.json(preview))
      .mockResolvedValueOnce(Response.json({ deploymentId: "dpl_other" }));
    await expect(
      tools.preview_inspect.execute?.(identity, options),
    ).resolves.toMatchObject({ aliasMatches: false });
    expect(
      upstream.mock.calls.every(
        ([request]) => request instanceof Request && request.method === "GET",
      ),
    ).toBe(true);
  });

  it("keeps unrelated writes, override fields, and raw CLI requests outside the write grant", async () => {
    fixture();
    for (const patch of [
      { target: "production" },
      { project: "prj_other" },
      { env: { SECRET: "value" } },
      { projectSettings: { buildCommand: "echo changed" } },
      {
        gitSource: {
          type: "github",
          org: "other",
          repo: "junior",
          ref: sha,
          sha,
        },
      },
      {
        gitSource: {
          type: "github",
          org: "getsentry",
          repo: "junior",
          ref: "main",
          sha,
        },
      },
    ]) {
      await expect(
        vercelGrantForEgress(createRequest(patch), scope),
      ).rejects.toThrow("exact-commit Preview");
    }
    for (const request of [
      { ...createRequest(), operation: undefined },
      {
        ...createRequest(),
        url: "https://api.vercel.com/v13/deployments?teamId=team_other",
      },
      { ...createRequest(), url: `${createRequest().url}&forceNew=1` },
      { ...createRequest(), bodyText: "{" },
      { ...createRequest(), method: "PATCH" },
    ])
      await expect(vercelGrantForEgress(request, scope)).rejects.toThrow(
        /Vercel|Preview|Deployment/,
      );
    await expect(vercelGrantForEgress(createRequest())).rejects.toThrow(
      "configured Preview tools",
    );
  });

  it("refuses writes to a Production or foreign deployment at the credential boundary", async () => {
    const { upstream } = fixture();
    const request = {
      method: "DELETE",
      operation: "vercel.preview.delete",
      url: `https://api.vercel.com/v13/deployments/${preview.id}?teamId=${scope.teamId}`,
    };
    for (const patch of [
      { target: "production" },
      { projectId: "prj_other" },
      { gitSource: { type: "github", sha, repoId: 999 } },
    ]) {
      upstream
        .mockResolvedValueOnce(Response.json(project))
        .mockResolvedValueOnce(Response.json({ ...preview, ...patch }));
      await expect(vercelGrantForEgress(request, scope)).rejects.toThrow(
        /Vercel|Preview|Deployment/,
      );
    }
    await expect(
      vercelGrantForEgress(
        { ...request, url: `${request.url}&url=production.example.com` },
        scope,
      ),
    ).rejects.toThrow("configured team");
  });

  it("refuses alias redirects and aliases outside the configured hostname", async () => {
    fixture();
    for (const body of [
      { alias: "production.example.com" },
      { alias: scope.alias, redirect: "other.example.com" },
    ]) {
      await expect(
        vercelGrantForEgress(
          {
            method: "POST",
            operation: "vercel.preview.select",
            url: `https://api.vercel.com/v2/deployments/${preview.id}/aliases?teamId=${scope.teamId}`,
            bodyText: JSON.stringify(body),
          },
          scope,
        ),
      ).rejects.toThrow("configured Preview alias");
    }
  });

  it("does not issue a write credential after scope lookup fails", async () => {
    const { upstream } = fixture();
    upstream.mockResolvedValueOnce(
      new Response("private details", { status: 403 }),
    );
    await expect(vercelGrantForEgress(createRequest(), scope)).rejects.toThrow(
      "HTTP 403",
    );
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("uses distinct host-only read and write credentials and disables tools by default", async () => {
    fixture();
    const read = await vercelGrantForEgress({
      method: "GET",
      url: "https://api.vercel.com/v6/deployments",
    });
    expect(issueVercelCredential(read)).toMatchObject({
      type: "lease",
      lease: {
        headerTransforms: [{ headers: { Authorization: "Bearer read-token" } }],
      },
    });
    const write = await vercelGrantForEgress(createRequest(), scope);
    expect(issueVercelCredential(write, scope)).toMatchObject({
      type: "lease",
      lease: {
        headerTransforms: [
          { headers: { Authorization: "Bearer write-token" } },
        ],
      },
    });
    vi.stubEnv("JUNIOR_VERCEL_PREVIEW_TOKEN", "");
    expect(issueVercelCredential(write, scope)).toMatchObject({
      type: "unavailable",
    });
    expect(
      vercelPlugin().hooks?.tools?.({} as ToolRegistrationHookContext),
    ).not.toHaveProperty("preview_create");
    expect(
      vercelPlugin({ preview: scope }).hooks?.tools?.(
        {} as ToolRegistrationHookContext,
      ),
    ).toHaveProperty("preview_create");
  });
});
