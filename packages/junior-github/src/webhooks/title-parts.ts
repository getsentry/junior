/**
 * The title parts of pull request item subjects, with each repository's
 * changelog categories from `.github/release.yml`.
 */
import type {
  PluginLogger,
  ReviewItemSubjectTitleParts,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  DEFAULT_CODE_CHANGE_CATEGORIES,
  parseCodeChangeTitle,
  type CodeChangeCategory,
} from "../code-change-titles/parse.js";
import { parseReleaseCategories } from "../code-change-titles/release-config.js";
import {
  GitHubRequestError,
  githubRequest,
  issueInstallationToken,
} from "../credential-support.js";
import { logFailOpenFailure } from "./fail-open-log.js";
import type { GitHubInstallationEnv } from "./installation-requests.js";

/** Read the title parts of one pull request title in its repository. */
export type LoadGitHubTitleParts = (input: {
  repositoryFullName: string;
  title: string;
}) => Promise<ReviewItemSubjectTitleParts | undefined>;

/** A repository without the file costs at most one read in this time. */
const MISSING_TTL_MS = 60 * 60_000;

const contentsSchema = z.object({
  content: z.string(),
  encoding: z.literal("base64"),
});

function missingKey(repositoryFullName: string): string {
  return `github-release-config-missing:${repositoryFullName.toLowerCase()}`;
}

/**
 * Read a repository's changelog categories from GitHub with a read-only
 * token. The file is read with its ETag, and a missing file is remembered
 * for an hour in `env.responses`.
 */
async function loadReleaseCategories(
  env: GitHubInstallationEnv,
  repositoryFullName: string,
): Promise<readonly CodeChangeCategory[]> {
  const [owner, name] = repositoryFullName.split("/");
  if (!owner || !name) return DEFAULT_CODE_CHANGE_CATEGORIES;
  const state = env.responses;
  if (await state?.get(missingKey(repositoryFullName)).catch(() => undefined)) {
    return DEFAULT_CODE_CHANGE_CATEGORIES;
  }
  const token = await issueInstallationToken({
    ...env,
    permissions: { contents: "read" },
    repositories: [name],
  });
  let response: unknown;
  try {
    response = await githubRequest(
      "https://api.github.com",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/.github/release.yml`,
      { responses: state, token: token.token },
    );
  } catch (error) {
    if (!(error instanceof GitHubRequestError) || error.status !== 404) {
      throw error;
    }
    await state
      ?.set(missingKey(repositoryFullName), true, MISSING_TTL_MS)
      .catch(() => undefined);
    return DEFAULT_CODE_CHANGE_CATEGORIES;
  }
  const file = contentsSchema.safeParse(response);
  if (!file.success) return DEFAULT_CODE_CHANGE_CATEGORIES;
  return parseReleaseCategories(
    Buffer.from(file.data.content, "base64").toString("utf8"),
  );
}

/**
 * Return the title parts of a pull request title with its repository's
 * changelog categories. Title parts are optional, so a failed read of the
 * categories is logged, and the default categories apply.
 */
export async function loadGitHubTitleParts(
  env: GitHubInstallationEnv,
  input: { repositoryFullName: string; title: string },
  log?: Pick<PluginLogger, "error" | "warn">,
): Promise<ReviewItemSubjectTitleParts | undefined> {
  let categories: readonly CodeChangeCategory[];
  try {
    categories = await loadReleaseCategories(env, input.repositoryFullName);
  } catch (error) {
    logFailOpenFailure(log, "GitHub release config read failed", error, {
      repository: input.repositoryFullName,
    });
    categories = DEFAULT_CODE_CHANGE_CATEGORIES;
  }
  return parseCodeChangeTitle(input.title, categories);
}
