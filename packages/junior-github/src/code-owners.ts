/**
 * The code owners that GitHub asks to review a pull request.
 *
 * GitHub reads the first CODEOWNERS file of the base branch, in `.github/`,
 * the repository root, or `docs/`. For each changed file the last matching
 * rule wins, and a matching rule with no owners leaves the file without
 * owners. GitHub asks the owners to review when the pull request is ready for
 * review, so a draft has not asked them yet.
 *
 * CODEOWNERS uses gitignore patterns, which the `ignore` package matches.
 * One difference: GitHub matches `docs/*` only to files directly in `docs/`,
 * and gitignore also matches the files below. That error finds too many
 * owners, never too few, so Junior does not ping owners it did not expect.
 */
import type { PluginEgress } from "@sentry/junior-plugin-api";
import ignore from "ignore";
import * as z from "zod";
import { PULL_REQUEST_CODE_OWNERS } from "./graphql-documents.js";
import { githubApi } from "./tool-support/github-api.js";

interface CodeOwnersRule {
  matches(path: string): boolean;
  owners: string[];
}

/** Parse the rules of one CODEOWNERS file, in file order. */
function parseCodeOwners(text: string): CodeOwnersRule[] {
  const rules: CodeOwnersRule[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [pattern, ...tokens] = line.trim().split(/\s+/);
    if (!pattern || pattern.startsWith("#")) continue;
    const comment = tokens.findIndex((token) => token.startsWith("#"));
    const matcher = ignore().add(pattern);
    rules.push({
      matches: (path) => matcher.ignores(path),
      owners: comment === -1 ? tokens : tokens.slice(0, comment),
    });
  }
  return rules;
}

/** Return the sorted owners of the given paths. */
function codeOwnersOf(rules: CodeOwnersRule[], paths: string[]): string[] {
  const owners = new Set<string>();
  for (const path of paths) {
    let last: CodeOwnersRule | undefined;
    for (const rule of rules) if (rule.matches(path)) last = rule;
    for (const owner of last?.owners ?? []) owners.add(owner);
  }
  return [...owners].sort();
}

// GitHub uses the first of these files that exists.
const CODE_OWNERS_PATHS = {
  githubExpression: ".github/CODEOWNERS",
  rootExpression: "CODEOWNERS",
  docsExpression: "docs/CODEOWNERS",
} as const;

const blobSchema = z.object({ text: z.string().nullish() }).nullable();
const responseSchema = z.object({
  data: z.object({
    repository: z.object({
      github: blobSchema,
      root: blobSchema,
      docs: blobSchema,
      pullRequest: z.object({
        files: z
          .object({
            nodes: z.array(z.object({ path: z.string() })),
            pageInfo: z.object({
              endCursor: z.string().nullable(),
              hasNextPage: z.boolean(),
            }),
          })
          .nullable(),
      }),
    }),
  }),
});

/**
 * Read the code owners of the files that one pull request changes, from the
 * CODEOWNERS file of its base branch.
 */
export async function readPullRequestCodeOwners(
  egress: PluginEgress,
  repo: { name: string; owner: string },
  pullRequest: { base: string; number: number },
): Promise<string[]> {
  const expressions = Object.fromEntries(
    Object.entries(CODE_OWNERS_PATHS).map(([key, path]) => [
      key,
      `${pullRequest.base}:${path}`,
    ]),
  );
  const paths: string[] = [];
  let codeOwners: string | undefined;
  let after: string | null = null;
  do {
    const response = await githubApi(egress, {
      operation: "github.pull.code_owners.get",
      method: "POST",
      path: "/graphql",
      body: {
        ...PULL_REQUEST_CODE_OWNERS,
        variables: {
          ...expressions,
          after,
          name: repo.name,
          number: pullRequest.number,
          owner: repo.owner,
        },
      },
    });
    if (!response.ok) {
      throw new Error(
        `GitHub pull request code owners lookup failed with HTTP ${response.status}`,
      );
    }
    const repository = responseSchema.parse(response.body).data.repository;
    codeOwners ??=
      repository.github?.text ??
      repository.root?.text ??
      repository.docs?.text ??
      undefined;
    const files = repository.pullRequest.files;
    if (!files) {
      // Without the changed files, no owners would read as "safe to mark
      // ready". Fail instead, so the draft stays a draft.
      if (codeOwners) {
        throw new Error(
          "GitHub did not list the changed files of the pull request",
        );
      }
      break;
    }
    paths.push(...files.nodes.map((file) => file.path));
    after = files.pageInfo.hasNextPage ? files.pageInfo.endCursor : null;
  } while (after);
  return codeOwners ? codeOwnersOf(parseCodeOwners(codeOwners), paths) : [];
}
