import {
  type PluginEgress,
  definePluginTool,
  pluginToolOutputSchema,
  subscribableResourceSchema,
  type PluginToolOutput,
  type SubscribableResource,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { gitHubReleaseSourceSubscribable } from "../events/release.js";
import { githubApi, parseRepo, repoPath } from "../tool-support/github-api.js";

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

function mapRelease(
  providerRelease: z.output<typeof providerReleaseSchema>,
): z.output<typeof releaseSchema> {
  return {
    created_at: providerRelease.created_at,
    draft: providerRelease.draft,
    html_url: providerRelease.html_url,
    id: providerRelease.id,
    name: providerRelease.name,
    prerelease: providerRelease.prerelease,
    published_at: providerRelease.published_at,
    tag_name: providerRelease.tag_name,
    target_commitish: providerRelease.target_commitish,
  };
}

/** Read release metadata and expose its stable subscription identity. */
export const gitHubGetReleaseTool = definePluginTool({
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
  async execute(
    input,
    _options,
    ctx: {
      egress: PluginEgress;
      events: { canSubscribe: boolean };
    },
  ): Promise<Result> {
    const repo = parseRepo(input.repo);
    const tag = input.tag?.trim() || undefined;
    let release: z.output<typeof releaseSchema> | null = null;

    if (tag) {
      const response = await githubApi(ctx.egress, {
        operation: "github.release.get",
        path: `${repoPath(repo)}/releases/tags/${encodeURIComponent(tag)}`,
      });
      if (response.ok) {
        release = mapRelease(providerReleaseSchema.parse(response.body));
      } else if (response.status !== 404) {
        throw new Error(
          `GitHub release lookup failed with HTTP ${response.status}`,
        );
      }
      // 404 keeps release null so the tag remains subscribable before publish.
    } else {
      // Prefer GitHub's non-draft latest endpoint so authenticated tokens with
      // push access cannot surface a draft as the current release.
      const response = await githubApi(ctx.egress, {
        operation: "github.release.latest",
        path: `${repoPath(repo)}/releases/latest`,
      });
      if (response.ok) {
        release = mapRelease(providerReleaseSchema.parse(response.body));
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

    const subscribable = gitHubReleaseSourceSubscribable({
      canSubscribe: ctx.events.canSubscribe,
      repo: repo.ref,
      tag,
    });
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
