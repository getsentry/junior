/**
 * GitHub plugin runtime boundary.
 *
 * This module composes GitHub hooks, resource events, and credentials.
 */
import {
  defineJuniorPlugin,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import {
  type GitHubAppPermissions,
  normalizePermissions,
  readGrantPermissions,
} from "./permissions.js";
import { createGitHubTools } from "./tools.js";
import { createGitHubWebhookRoute } from "./webhooks/handler.js";
import {
  GITHUB_DEPLOYMENT_EVENTS,
  GITHUB_DEPLOYMENT_SUGGESTED_EVENTS,
} from "./resource-events/deployment.js";
import {
  GITHUB_ISSUE_EVENTS,
  GITHUB_ISSUE_SUGGESTED_EVENTS,
} from "./resource-events/issue.js";
import {
  GITHUB_PULL_REQUEST_EVENTS,
  GITHUB_PULL_REQUEST_MATCH_FIELDS,
  GITHUB_PULL_REQUEST_SUGGESTED_EVENTS,
  type GitHubPullRequestEventOptions,
} from "./resource-events/pull-request.js";
import {
  GITHUB_RELEASE_EVENTS,
  GITHUB_RELEASE_SUGGESTED_EVENTS,
} from "./resource-events/release.js";
import type { GitHubDb } from "./db/database.js";
import { classifyGitHubPullRequestCommitComposition } from "./pull-request-outcomes/commit-composition.js";
import { githubSidebarAnnotations } from "./annotations.js";
import {
  listGitHubAssignedWork,
  listGitHubFinishedWork,
  listGitHubUnfinishedWork,
} from "./pull-request-outcomes/store.js";
import {
  additionalActorCoauthorTrailers,
  configureGit,
  prepareCommitMsgHook,
} from "./git-config.js";
import { linkifyGitHubReferences } from "./reply-markdown.js";
import { prepareWorkspace } from "./workspace-prepare.js";
import {
  githubGrantForEgress,
  githubGraphqlPermissionDeniedMessage,
  shouldInspectGitHubGraphqlResponse,
} from "./egress-policy.js";
import {
  GITHUB_APP_ID_ENV,
  GITHUB_APP_PRIVATE_KEY_ENV,
  GITHUB_AUTH_TOKEN_ENV,
  GITHUB_AUTH_TOKEN_PLACEHOLDER,
  GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES,
  GITHUB_INSTALLATION_ID_ENV,
  USER_TOKEN_GRANTS,
  GitHubPluginSetupError,
  createPermissionCache,
  credentialUnavailable,
  githubRequest,
  issueInstallationCredential,
  issueInstallationToken,
  issueUserCredential,
  normalizeScopeList,
  readEnv,
  requireEnv,
  resolveUserAccount,
} from "./credential-support.js";

/** Configure the built-in GitHub plugin manifest and hooks. */
export interface GitHubPluginOptions {
  /**
   * Extra OAuth `scope` values to request during GitHub App user authorization.
   *
   * GitHub App user tokens report empty scopes, so Junior treats this as a
   * local reauthorization contract only. Effective access still comes from the
   * app permissions, installation repositories, and requesting user's access.
   */
  additionalUserScopes?: string[];

  /**
   * GitHub App permissions Junior should downscope to read for
   * installation-read tokens.
   *
   * Keys may use GitHub permission names with underscores or hyphens.
   * Installation-write tokens inherit the App installation's complete
   * permission envelope. GitHub remains the source of truth for whether a
   * permission exists.
   */
  appPermissions?: GitHubAppPermissions;

  /** Environment variable containing the GitHub App id. */
  appIdEnv?: string;

  /** Environment variable containing Junior's Git committer email. */
  botEmailEnv?: string;

  /** Environment variable containing Junior's Git committer name. */
  botNameEnv?: string;

  /** Environment variable containing the GitHub App OAuth client id. */
  clientIdEnv?: string;

  /** Environment variable containing the GitHub App OAuth client secret. */
  clientSecretEnv?: string;

  /** Environment variable containing the GitHub App installation id. */
  installationIdEnv?: string;
  /** Environment variable containing the GitHub App private key. */
  privateKeyEnv?: string;
  /** App-configured pull request resource event behavior. */
  pullRequestEvents?: GitHubPullRequestEventOptions;
}

/** Register GitHub runtime hooks for repository workflows. */
export function githubPlugin(
  options: GitHubPluginOptions = {},
): PluginRegistration {
  const botNameEnv = options.botNameEnv ?? "GITHUB_APP_BOT_NAME";
  const botEmailEnv = options.botEmailEnv ?? "GITHUB_APP_BOT_EMAIL";
  const clientIdEnv = options.clientIdEnv ?? "GITHUB_APP_CLIENT_ID";
  const clientSecretEnv = options.clientSecretEnv ?? "GITHUB_APP_CLIENT_SECRET";
  const appIdEnv = options.appIdEnv ?? GITHUB_APP_ID_ENV;
  const privateKeyEnv = options.privateKeyEnv ?? GITHUB_APP_PRIVATE_KEY_ENV;
  const installationIdEnv =
    options.installationIdEnv ?? GITHUB_INSTALLATION_ID_ENV;
  const declaredAppPermissions = normalizePermissions(options.appPermissions);
  const declaredReadPermissions = declaredAppPermissions
    ? readGrantPermissions(declaredAppPermissions)
    : undefined;
  const loadReadPermissions = createPermissionCache();
  const userScopes = normalizeScopeList(options.additionalUserScopes);
  const userScope = userScopes.length ? userScopes.join(" ") : undefined;

  return defineJuniorPlugin({
    packageName: "@sentry/junior-github",
    resourceEvents: {
      resourceTypes: [
        {
          type: "deployment_source",
          supportedEvents: [...GITHUB_DEPLOYMENT_EVENTS],
          suggestedEvents: [...GITHUB_DEPLOYMENT_SUGGESTED_EVENTS],
        },
        {
          type: "issue",
          supportedEvents: [...GITHUB_ISSUE_EVENTS],
          suggestedEvents: [...GITHUB_ISSUE_SUGGESTED_EVENTS],
        },
        {
          type: "pull_request",
          supportedEvents: [...GITHUB_PULL_REQUEST_EVENTS],
          suggestedEvents: [...GITHUB_PULL_REQUEST_SUGGESTED_EVENTS],
          matchFields: GITHUB_PULL_REQUEST_MATCH_FIELDS,
          ...(options.pullRequestEvents?.guidance
            ? { guidance: options.pullRequestEvents.guidance }
            : undefined),
        },
        {
          type: "release_source",
          supportedEvents: [...GITHUB_RELEASE_EVENTS],
          suggestedEvents: [...GITHUB_RELEASE_SUGGESTED_EVENTS],
        },
        {
          type: "repository",
          supportedEvents: [...GITHUB_ISSUE_EVENTS, ...GITHUB_PULL_REQUEST_EVENTS],
          suggestedEvents: [
            "issue.opened",
            "pull_request.opened",
            ...GITHUB_ISSUE_SUGGESTED_EVENTS,
            ...GITHUB_PULL_REQUEST_SUGGESTED_EVENTS,
          ],
          matchFields: GITHUB_PULL_REQUEST_MATCH_FIELDS,
        },
      ],
      isEnabled: () => Boolean(readEnv("GITHUB_WEBHOOK_SECRET")),
      normalizeIdentifier: (identifier) => identifier.toLowerCase(),
    },
    manifest: {
      name: "github",
      displayName: "GitHub",
      description:
        "GitHub deployment, issue, pull request, release, and repository workflows via GitHub App",
      configKeys: ["org", "repo"],
      domains: ["api.github.com", "github.com", "uploads.github.com"],
      envVars: {
        [appIdEnv]: {},
        [privateKeyEnv]: {},
        [installationIdEnv]: {},
        [clientIdEnv]: {},
        [clientSecretEnv]: {},
        [botNameEnv]: { exposeToCommandEnv: true },
        [botEmailEnv]: { exposeToCommandEnv: true },
      },
      oauth: {
        clientIdEnv,
        clientSecretEnv,
        authorizeEndpoint: "https://github.com/login/oauth/authorize",
        tokenEndpoint: "https://github.com/login/oauth/access_token",
        // GitHub App user-to-server tokens always return scope: "" regardless
        // of what was requested; treat empty response scope as unreported.
        treatEmptyScopeAsUnreported: true,
        ...(userScope ? { scope: userScope } : undefined),
      },
      commandEnv: {
        [GITHUB_AUTH_TOKEN_ENV]: GITHUB_AUTH_TOKEN_PLACEHOLDER,
        GIT_COMMITTER_NAME: `\${${botNameEnv}}`,
        GIT_COMMITTER_EMAIL: `\${${botEmailEnv}}`,
      },
      target: {
        type: "repo",
        configKey: "repo",
        commandFlags: ["--repo", "-R"],
      },
      runtimeDependencies: [
        {
          type: "system",
          package: "gh",
        },
        {
          type: "system",
          package: "jq",
        },
      ],
    },
    hooks: {
      conversationSidebar(ctx) {
        return {
          annotationsByConversationId: Object.fromEntries(
            ctx.conversationIds.flatMap((conversationId) => {
              const annotations = githubSidebarAnnotations(
                ctx.annotationsByConversationId[conversationId] ?? [],
              );
              return annotations.length > 0
                ? [[conversationId, annotations]]
                : [];
            }),
          ),
        };
      },
      formatMarkdown({ text }) {
        return linkifyGitHubReferences(text);
      },
      async unfinishedWork(ctx) {
        const db = ctx.db as GitHubDb;
        const [
          conversationIds,
          assignedConversationIds,
          finishedWorkAtByConversationId,
        ] = await Promise.all([
          listGitHubUnfinishedWork(db, ctx.conversationIds),
          listGitHubAssignedWork(db, ctx.conversationIds),
          listGitHubFinishedWork(db, ctx.conversationIds),
        ]);
        return {
          conversationIds,
          assignedConversationIds,
          finishedWorkAtByConversationId,
        };
      },
      routes(ctx) {
        return [
          createGitHubWebhookRoute({
            annotations: ctx.annotations,
            appIdEnv,
            botEmail: () => readEnv(botEmailEnv),
            classifyPullRequestCommits: async ({
              number,
              repositoryFullName,
            }) => {
              const [owner, name, ...extra] = repositoryFullName.split("/");
              if (!owner || !name || extra.length > 0) {
                throw new Error(
                  "GitHub pull request commit classification received an invalid repository name",
                );
              }
              const token = await issueInstallationToken({
                appIdEnv,
                privateKeyEnv,
                installationIdEnv,
                permissions: { pull_requests: "read" },
                repositories: [name],
              });
              return await classifyGitHubPullRequestCommitComposition({
                botEmail: requireEnv(botEmailEnv),
                loadPage: async (page, perPage) =>
                  await githubRequest(
                    "https://api.github.com",
                    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${number}/commits?per_page=${perPage}&page=${page}`,
                    { token: token.token },
                  ),
              });
            },
            codeChanges: ctx.codeChanges,
            db: ctx.db as GitHubDb,
            installationId: () => readEnv(installationIdEnv),
            installationIdEnv,
            log: ctx.log,
            privateKeyEnv,
            resourceEvents: ctx.resourceEvents,
            webhookSecret: () => readEnv("GITHUB_WEBHOOK_SECRET"),
          }),
        ];
      },
      tools(ctx) {
        return createGitHubTools(
          ctx,
          readEnv(botEmailEnv),
          options.pullRequestEvents?.subscribeAfterCreate,
        );
      },
      workspacePrepare: prepareWorkspace,
      async sandboxPrepare(ctx) {
        const hooksPath = `${ctx.sandbox.juniorRoot}/git-hooks`;
        await ctx.sandbox.writeFile({
          path: `${hooksPath}/prepare-commit-msg`,
          mode: 0o755,
          content: prepareCommitMsgHook(),
        });
        await configureGit(ctx, "core.hooksPath", hooksPath);
        await configureGit(ctx, "commit.gpgsign", "false");
        await configureGit(ctx, "credential.helper", "");
        await configureGit(ctx, "http.emptyAuth", "true");
      },
      beforeToolExecute(ctx) {
        if (ctx.tool.name !== "bash") {
          return;
        }
        const botName = requireEnv(botNameEnv);
        const botEmail = requireEnv(botEmailEnv);
        ctx.env.set("GIT_AUTHOR_NAME", botName);
        ctx.env.set("GIT_AUTHOR_EMAIL", botEmail);
        ctx.env.set("JUNIOR_GIT_AUTHOR_NAME", botName);
        ctx.env.set("JUNIOR_GIT_AUTHOR_EMAIL", botEmail);
        ctx.env.set("GIT_COMMITTER_NAME", botName);
        ctx.env.set("GIT_COMMITTER_EMAIL", botEmail);
        const actorTrailers = additionalActorCoauthorTrailers({
          actors: [...(ctx.actor ? [ctx.actor] : []), ...(ctx.actors ?? [])],
          botEmail,
        });
        ctx.env.set(
          "JUNIOR_GIT_ACTOR_COAUTHOR_TRAILERS",
          actorTrailers.join("\n"),
        );
      },
      grantForEgress(ctx) {
        return githubGrantForEgress(ctx);
      },
      async onEgressResponse(ctx) {
        if (!shouldInspectGitHubGraphqlResponse(ctx)) {
          return;
        }
        const bodyText = await ctx.response.readText(
          GITHUB_GRAPHQL_RESPONSE_BODY_LIMIT_BYTES,
        );
        if (!bodyText) {
          return;
        }
        const message = githubGraphqlPermissionDeniedMessage(bodyText);
        if (message) {
          ctx.permissionDenied(message);
        }
      },
      async resolveOAuthAccount(ctx) {
        return await resolveUserAccount(ctx.tokens);
      },
      async issueCredential(ctx) {
        try {
          if (ctx.grant.name === "installation-read") {
            return await issueInstallationCredential({
              appIdEnv,
              privateKeyEnv,
              installationIdEnv,
              ...(declaredReadPermissions
                ? { permissions: declaredReadPermissions }
                : { loadPermissions: loadReadPermissions }),
            });
          }
          if (ctx.grant.name === "installation-write") {
            // Use the full installed App permissions. Repo allowlisting stays in
            // egress policy, not in per-request token minting.
            return await issueInstallationCredential({
              appIdEnv,
              privateKeyEnv,
              installationIdEnv,
            });
          }
          if (USER_TOKEN_GRANTS.has(ctx.grant.name)) {
            return await issueUserCredential(ctx, {
              clientIdEnv,
              clientSecretEnv,
              userScope,
            });
          }
        } catch (error) {
          if (error instanceof GitHubPluginSetupError) {
            return credentialUnavailable(error.message);
          }
          throw error;
        }
        throw new Error(
          `GitHub plugin cannot issue unknown grant "${ctx.grant.name}".`,
        );
      },
    },
  });
}
