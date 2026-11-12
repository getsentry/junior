import { parse, print } from "@0no-co/graphql.web";
import { describe, expect, it } from "vitest";
import { pullRequestLifecycles } from "../src/graphql-documents.js";

describe("GitHub GraphQL documents", () => {
  it("repeats one aliased pull request field for each lifecycle", () => {
    const { operationName, query } = pullRequestLifecycles(2);

    expect(operationName).toBe("PullRequestLifecycles");
    expect(query).toBe(
      print(
        parse(`
          query PullRequestLifecycles($owner: String!, $name: String!, $n0: Int!, $n1: Int!) {
            repository(owner: $owner, name: $name) {
              databaseId
              nameWithOwner
              pr0: pullRequest(number: $n0) { ...Lifecycle }
              pr1: pullRequest(number: $n1) { ...Lifecycle }
            }
          }

          fragment Lifecycle on PullRequest {
            assignees(first: 20) { nodes { login } }
            author { __typename login }
            closedAt
            createdAt
            databaseId
            headRefName
            isDraft
            merged
            mergedAt
            number
            state
            title
            updatedAt
          }
        `),
      ),
    );
  });
});
