import {
  definePluginTool,
  PluginToolInputError,
  pluginToolOutputSchema,
  subscribableResourceSchema,
  type PluginToolOutput,
  type SubscribableResource,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import { gitHubReleaseSourceSubscribable } from "../resource-events/release.js";

const inputSchema = z
  .object({
    repo: z.string().describe('Repository in "owner/name" format.'),
    tag: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Optional release tag name. Omit to inspect and watch every published release in the repository.",
      )
      .optional(),
  })
  .strict();
const releaseSchema = z
  .object({
    createdAt: z.string(),
    draft: z.boolean(),
    htmlUrl: z.string(),
    id: z.number(),
    name: z.string().nullable(),
    prerelease: z.boolean(),
    publishedAt: z.string().nullable(),
    tagName: z.string(),
    targetCommitish: z.string(),
  })
  .strict();
const releaseSourceSchema = z
  .object({
    release: releaseSchema.nullable(),
    repo: z.string(),
    subscribable: subscribableResourceSchema.optional(),
    tag: z.string().nullable(),
  })
  .strict();
type ReleaseSource = z.output<typeof releaseSourceSchema>;
interface Result extends PluginToolOutput, ReleaseSource {
  subscribable?: SubscribableResource;
  target: "getRelease";
}
const outputSchema = pluginToolOutputSchema.merge(
  releaseSourceSchema.extend({
    target: z.literal("getRelease"),
  }),
);

const providerReleaseSchema = z
  .object({
    created_at: z.string(),
    draft: z.boolean(),
    html_url: z.string(),
    id: z.number(),
    name: z.string().nullable(),
    prerelease: z.boolean(),
    published_at: z.string().nullable(),
    tag_name: z.string(),
    target_commitish: z.string(),
  })
  .passthrough();

function parseRepo(value: string) {
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PluginToolInputError('repo must use "owner/name" format');
  }
  return { owner: parts[0], name: parts[1], ref: `${parts[0]}/${parts[1]}` };
}

/** Read a provider response without assuming its error body is JSON. */
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function repositoryUrl(repo: { name: string; owner: string }, path: string) {
  return `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${path}`;
}

function mapRelease(
  providerRelease: z.output<typeof providerReleaseSchema>,
): z.output<typeof releaseSchema> {
  return {
    createdAt: providerRelease.created_at,
    draft: providerRelease.draft,
    htmlUrl: providerRelease.html_url,
    id: providerRelease.id,
    name: providerRelease.name,
    prerelease: providerRelease.prerelease,
    publishedAt: providerRelease.published_at,
    tagName: providerRelease.tag_name,
    targetCommitish: providerRelease.target_commitish,
  };
}

/** Read release metadata and expose its stable subscription identity. */
export function createGitHubGetReleaseTool(ctx: ToolRegistrationHookContext) {
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Get a GitHub release for an exact repository, optionally limited to one tag. The result remains subscribable when no release exists yet, so use it before waiting for a published release. Omit the tag to watch every published release in the repository.",
    inputSchema,
    outputSchema,
    async execute(input): Promise<Result> {
      const repo = parseRepo(input.repo);
      const tag = input.tag?.trim() || undefined;
      let release: z.output<typeof releaseSchema> | null = null;

      if (tag) {
        const response = await ctx.egress.fetch({
          provider: "github",
          operation: "github.release.get",
          request: new Request(
            repositoryUrl(repo, `releases/tags/${encodeURIComponent(tag)}`),
            {
              headers: {
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            },
          ),
        });
        const body = await readJson(response);
        if (response.ok) {
          release = mapRelease(providerReleaseSchema.parse(body));
        } else if (response.status !== 404) {
          throw new Error(
            `GitHub release lookup failed with HTTP ${response.status}`,
          );
        }
        // 404 keeps release null so the tag remains subscribable before publish.
      } else {
        // Prefer GitHub's non-draft latest endpoint so authenticated tokens with
        // push access cannot surface a draft as the current release.
        const response = await ctx.egress.fetch({
          provider: "github",
          operation: "github.release.latest",
          request: new Request(repositoryUrl(repo, "releases/latest"), {
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }),
        });
        const body = await readJson(response);
        if (response.ok) {
          release = mapRelease(providerReleaseSchema.parse(body));
        } else if (response.status === 404) {
          // Missing repo and "no published release yet" both 404. Keep the
          // repository-wide source subscribable either way.
          release = null;
        } else {
          throw new Error(
            `GitHub release lookup failed with HTTP ${response.status}`,
          );
        }
      }

      const subscribable = ctx.resourceEvents.canSubscribe
        ? gitHubReleaseSourceSubscribable({
            repo: repo.ref,
            tag,
          })
        : undefined;
      const data: ReleaseSource = {
        release,
        repo: repo.ref,
        tag: tag ?? null,
        ...(subscribable ? { subscribable } : undefined),
      };
      return {
        target: "getRelease",
        ...data,
      };
    },
  });
}
