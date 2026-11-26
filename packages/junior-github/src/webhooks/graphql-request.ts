/**
 * GitHub GraphQL requests that fail on a response with errors and no data.
 */
import * as z from "zod";
import { githubRequest } from "../credential-support.js";

/**
 * A GitHub GraphQL response with errors and no data. GitHub sends it with
 * HTTP 200, such as when the installation is rate limited.
 */
export class GitHubGraphqlError extends Error {
  /** GitHub's error types, such as `RATE_LIMIT`. GitHub's own failures have none. */
  readonly types: string[];

  constructor(message: string, types: string[]) {
    super(message);
    this.name = "GitHubGraphqlError";
    this.types = types;
  }
}

const graphqlFailureSchema = z.object({
  data: z.null().optional(),
  errors: z
    .array(z.object({ message: z.string(), type: z.string().optional() }))
    .min(1),
});

/**
 * Send a GitHub GraphQL request. Throw `GitHubGraphqlError` when GitHub
 * returns errors and no data, so the caller does not read a missing result.
 * A response with partial data returns as usual.
 */
export async function githubGraphqlRequest(params: {
  body: unknown;
  token: string;
}): Promise<unknown> {
  const response = await githubRequest("https://api.github.com", "/graphql", {
    ...params,
    method: "POST",
  });
  const failure = graphqlFailureSchema.safeParse(response);
  if (failure.success) {
    throw new GitHubGraphqlError(
      failure.data.errors
        .map((error) =>
          error.type ? `${error.type}: ${error.message}` : error.message,
        )
        .join("; "),
      failure.data.errors.flatMap((error) => (error.type ? [error.type] : [])),
    );
  }
  return response;
}
