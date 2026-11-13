import {
  definePluginTool,
  EgressAuthRequired,
  PluginToolInputError,
  pluginToolOutputSchema,
  type PluginToolExecuteOptions,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import { GITHUB_REPOSITORY_CREATE_OPERATION_PREFIX } from "../egress-policy.js";
import {
  linkedGitHubLogin,
  resolveGitHubRequester,
} from "../tool-support/attribution.js";
import {
  githubApi,
  githubErrorMessage,
  repoPath,
} from "../tool-support/github-api.js";

const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_TTL_MS = 60_000;
// GitHub organization logins, team slugs, and repository names. A name
// cannot be "." or "..".
const ORG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TEAM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Names that GitHub gives a special meaning, such as an organization profile
// (`.github`), a Pages site (`*.github.io`), or a Git or wiki remote path.
// GitHub compares repository names without case.
const RESERVED_NAME_PATTERN = /^\.github|\.github\.io$|\.git$|\.wiki$/i;
// Every repository that Junior creates carries this organization custom
// property, so owners can find and govern them. Profiles and tool input
// cannot set `custom_properties`, and the create body sets it last.
const PROVISIONED_BY_PROPERTIES = { "provisioned-by": "jr" } as const;

/**
 * Fields of `POST /orgs/{org}/repos` that a profile fixes. Junior sets
 * `name`, `description`, `team_id`, and `custom_properties` itself. `delete_branch_on_merge` is
 * absent: GitHub lets only an organization owner set it to true.
 */
const repositorySettingsSchema = z
  .object({
    visibility: z.enum(["private", "public"]),
    has_issues: z.boolean().optional(),
    has_projects: z.boolean().optional(),
    has_wiki: z.boolean().optional(),
    auto_init: z.boolean().optional(),
    gitignore_template: z.string().min(1).optional(),
    license_template: z.string().min(1).optional(),
    allow_squash_merge: z.boolean().optional(),
    allow_merge_commit: z.boolean().optional(),
    allow_rebase_merge: z.boolean().optional(),
    allow_auto_merge: z.boolean().optional(),
    squash_merge_commit_title: z
      .enum(["PR_TITLE", "COMMIT_OR_PR_TITLE"])
      .optional(),
    squash_merge_commit_message: z
      .enum(["PR_BODY", "COMMIT_MESSAGES", "BLANK"])
      .optional(),
    merge_commit_title: z.enum(["PR_TITLE", "MERGE_MESSAGE"]).optional(),
    merge_commit_message: z.enum(["PR_BODY", "PR_TITLE", "BLANK"]).optional(),
  })
  .strict()
  // GitHub rejects a commit message default without its title default.
  .refine(
    (settings) =>
      (!settings.squash_merge_commit_message ||
        settings.squash_merge_commit_title) &&
      (!settings.merge_commit_message || settings.merge_commit_title),
    "A commit message setting needs its commit title setting.",
  );

const repositoryProfileSchema = z
  .object({
    org: z.string().regex(ORG_PATTERN),
    teams: z.array(z.string().regex(TEAM_PATTERN)).min(1).optional(),
    settings: repositorySettingsSchema,
  })
  .strict();

const repositoryProfilesSchema = z
  .record(z.string().regex(PROFILE_PATTERN), repositoryProfileSchema)
  .refine(
    (profiles) => Object.keys(profiles).length > 0,
    "Configure at least one repository profile.",
  );

/**
 * One kind of repository that Junior may create. The operator fixes the
 * organization and every setting; the agent picks only the profile, the
 * name, the owning team, and the description.
 */
export type GitHubRepositoryProfile = z.input<typeof repositoryProfileSchema>;
/** Validated repository profiles, keyed by profile name. */
export type GitHubRepositoryProfiles = z.output<
  typeof repositoryProfilesSchema
>;
type RepositoryProfile = GitHubRepositoryProfiles[string];

/** Validate operator repository profiles when the plugin is configured. */
export function parseGitHubRepositoryProfiles(
  profiles: Record<string, GitHubRepositoryProfile>,
): GitHubRepositoryProfiles {
  return repositoryProfilesSchema.parse(profiles);
}

function createInputSchema(profiles: GitHubRepositoryProfiles) {
  const names = Object.keys(profiles);
  const summary = names
    .map((name) => {
      const profile = profiles[name]!;
      return `${name} (${profile.settings.visibility} in ${profile.org})`;
    })
    .join(", ");
  return z
    .object({
      profile: z
        .enum(names as [string, ...string[]])
        .describe(
          `Repository profile. It fixes the organization and all settings: ${summary}.`,
        ),
      name: z
        .string()
        .regex(
          NAME_PATTERN,
          "name may use only letters, digits, '.', '-', and '_'",
        )
        .describe("Name of the new repository."),
      team: z
        .string()
        .regex(TEAM_PATTERN, "team must be a GitHub team slug")
        .describe(
          "Slug of the team that owns the repository. The requester must be a member of it.",
        ),
      description: z
        .string()
        .max(350)
        .describe("Short description of the repository.")
        .optional(),
    })
    .strict();
}
type Input = z.output<ReturnType<typeof createInputSchema>>;

const repositorySchema = z.object({
  default_branch: z.string().nullable(),
  full_name: z.string(),
  private: z.boolean(),
  url: z.string(),
});
type Repository = z.output<typeof repositorySchema>;

const outputSchema = pluginToolOutputSchema.merge(
  repositorySchema.extend({ target: z.literal("createRepository") }),
);

/**
 * Durable idempotency record. `pending` blocks a retry whose first request
 * may have created the repository; `completed` replays the result.
 */
const stateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }).strict(),
  z
    .object({ status: z.literal("completed"), repository: repositorySchema })
    .strict(),
]);

const teamSchema = z.object({ id: z.number().int() });
const membershipSchema = z.object({ state: z.string() });

const providerRepositorySchema = z.object({
  default_branch: z.string().nullable().optional(),
  full_name: z.string(),
  html_url: z.string(),
  private: z.boolean(),
});

function isEgressAuthRequired(error: unknown): boolean {
  return (
    error instanceof EgressAuthRequired ||
    (error instanceof Error && error.name === "EgressAuthRequired")
  );
}

function profileFor(
  profiles: GitHubRepositoryProfiles,
  input: Input,
): RepositoryProfile {
  const profile = Object.hasOwn(profiles, input.profile)
    ? profiles[input.profile]
    : undefined;
  if (!profile) {
    throw new PluginToolInputError(
      `Unknown repository profile "${input.profile}". Use one of: ${Object.keys(profiles).join(", ")}.`,
    );
  }
  return profile;
}

/**
 * Refuse a name that an organization repository has used. GitHub answers
 * 301 for the old name of a renamed or transferred repository. A new
 * repository with that name breaks the redirect, so links and Git remotes
 * would point at the new repository.
 */
async function requireUnusedName(
  ctx: ToolRegistrationHookContext,
  org: string,
  name: string,
): Promise<void> {
  // Egress does not follow redirects, so a renamed repository stays a 301.
  const response = await githubApi(ctx.egress, {
    operation: "github.repository.get",
    path: repoPath({ owner: org, name }),
  });
  if (response.status === 404) return;
  if (response.status === 200) {
    throw new PluginToolInputError(
      `GitHub repository ${org}/${name} already exists. Choose another name.`,
    );
  }
  if (response.status === 301) {
    throw new PluginToolInputError(
      `${org}/${name} is the old name of a renamed or transferred repository, and GitHub redirects it. Choose another name.`,
    );
  }
  throw new Error(
    `GitHub repository lookup failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`,
  );
}

/**
 * Return the id of the owning team after code checks that the profile allows
 * it and that the requester's linked GitHub account is an active member.
 */
async function owningTeamId(
  ctx: ToolRegistrationHookContext,
  profile: RepositoryProfile,
  input: Input,
): Promise<number> {
  const team = input.team.toLowerCase();
  if (profile.teams && !profile.teams.some((t) => t.toLowerCase() === team)) {
    throw new PluginToolInputError(
      `Profile "${input.profile}" does not allow team "${input.team}". Use one of: ${profile.teams.join(", ")}.`,
    );
  }
  const login = linkedGitHubLogin((await resolveGitHubRequester(ctx))?.user);
  if (!login) {
    throw new PluginToolInputError(
      "Creating a repository needs the requester's linked GitHub account, to check their team membership. Ask the requester to connect their GitHub account to Junior, then retry.",
    );
  }
  const teamPath = `/orgs/${encodeURIComponent(profile.org)}/teams/${encodeURIComponent(team)}`;
  const teamResponse = await githubApi(ctx.egress, {
    operation: "github.team.get",
    path: teamPath,
  });
  if (teamResponse.status === 404) {
    throw new PluginToolInputError(
      `GitHub team "${input.team}" does not exist in ${profile.org}.`,
    );
  }
  if (!teamResponse.ok) {
    throw new Error(
      `GitHub team lookup failed with HTTP ${teamResponse.status}: ${githubErrorMessage(teamResponse.body)}`,
    );
  }
  const membership = await githubApi(ctx.egress, {
    operation: "github.team.membership.get",
    path: `${teamPath}/memberships/${encodeURIComponent(login)}`,
  });
  // GitHub answers 404 when the account is not in the team.
  if (
    membership.status === 404 ||
    (membership.ok &&
      membershipSchema.parse(membership.body).state !== "active")
  ) {
    throw new PluginToolInputError(
      `The requester's GitHub account ${login} is not an active member of ${profile.org}/${input.team}. Only a member of the owning team can create its repository.`,
    );
  }
  if (!membership.ok) {
    throw new Error(
      `GitHub team membership lookup failed with HTTP ${membership.status}: ${githubErrorMessage(membership.body)}`,
    );
  }
  return teamSchema.parse(teamResponse.body).id;
}

/** Send the create request. An authorization pause creates nothing. */
async function sendCreate(
  ctx: ToolRegistrationHookContext,
  input: { org: string; body: Record<string, unknown>; name: string },
  key: string,
) {
  try {
    return await githubApi(ctx.egress, {
      operation: `${GITHUB_REPOSITORY_CREATE_OPERATION_PREFIX}${input.org}/${input.name}`,
      method: "POST",
      path: `/orgs/${encodeURIComponent(input.org)}/repos`,
      body: input.body,
    });
  } catch (error) {
    if (isEgressAuthRequired(error)) await ctx.state.delete(key);
    throw error;
  }
}

/**
 * Create a GitHub organization repository from an operator profile. The
 * owning team gets access at creation, and no person is added.
 */
export function createGitHubCreateRepositoryTool(
  profiles: GitHubRepositoryProfiles,
) {
  const inputSchema = createInputSchema(profiles);
  return definePluginTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: false,
    },
    describeProposal: (input) => {
      const profile = profiles[input.profile];
      return profile
        ? `Create ${profile.settings.visibility} GitHub repository ${profile.org}/${input.name} from profile ${input.profile}, owned by team ${input.team}`
        : `Create GitHub repository ${input.name} from unknown profile ${input.profile}`;
    },
    description:
      "Create a new GitHub repository from a repository profile. The profile fixes the organization and all settings. The owning team gets access, and the requester must be a member of it. Use this instead of gh repo create.",
    exposure: "direct",
    inputSchema,
    outputSchema,
    async execute(
      input,
      options: PluginToolExecuteOptions,
      ctx: ToolRegistrationHookContext,
    ) {
      const conversationId = ctx.conversationId;
      const toolCallId = options.toolCallId;
      if (!conversationId || !toolCallId) {
        throw new Error(
          "GitHub repository creation needs a conversation and a tool call id.",
        );
      }
      const profile = profileFor(profiles, input);
      if (RESERVED_NAME_PATTERN.test(input.name)) {
        throw new PluginToolInputError(
          `"${input.name}" is reserved. A repository name cannot start with ".github" or end with ".github.io", ".git", or ".wiki".`,
        );
      }
      const key = `createRepository:${conversationId}:${toolCallId}`;
      return await ctx.state.withLock(`${key}:lock`, LOCK_TTL_MS, async () => {
        const stored = await ctx.state.get(key);
        const state =
          stored === undefined ? undefined : stateSchema.parse(stored);
        if (state?.status === "completed") {
          return { target: "createRepository" as const, ...state.repository };
        }
        if (state?.status === "pending") {
          throw new Error(
            "GitHub repository creation for this tool call has an uncertain result; refusing to create it again. Check whether the repository exists.",
          );
        }
        const teamId = await owningTeamId(ctx, profile, input);
        await requireUnusedName(ctx, profile.org, input.name);
        await ctx.state.set(key, { status: "pending" }, IDEMPOTENCY_TTL_MS);
        const response = await sendCreate(
          ctx,
          {
            org: profile.org,
            name: input.name,
            body: {
              ...profile.settings,
              name: input.name,
              ...(input.description
                ? { description: input.description }
                : undefined),
              team_id: teamId,
              custom_properties: PROVISIONED_BY_PROPERTIES,
            },
          },
          key,
        );
        if (!response.ok) {
          const message = `GitHub repository creation failed with HTTP ${response.status}: ${githubErrorMessage(response.body)}`;
          // A 4xx refused the create, so a retry cannot duplicate it. It
          // names the cause, such as an organization without the App or a
          // taken name. A 5xx may still have created it, so pending stays.
          if (response.status < 500) {
            await ctx.state.delete(key);
            throw new PluginToolInputError(message);
          }
          throw new Error(message);
        }
        const created = providerRepositorySchema.parse(response.body);
        const repository: Repository = {
          default_branch: created.default_branch ?? null,
          full_name: created.full_name,
          private: created.private,
          url: created.html_url,
        };
        await ctx.state.set(
          key,
          { status: "completed", repository },
          IDEMPOTENCY_TTL_MS,
        );
        return { target: "createRepository" as const, ...repository };
      });
    },
  });
}
