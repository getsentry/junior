/**
 * The GitHub GraphQL documents that the plugin sends.
 *
 * The `junior/github-graphql-schema` lint rule validates each
 * `githubGraphql(...)` document against GitHub's public schema. Response
 * shapes stay with the zod schema at each call site.
 */
import {
  Kind,
  parse,
  print,
  visit,
  type DocumentNode,
  type SelectionNode,
  type VariableNode,
} from "@0no-co/graphql.web";

/** The `operationName` and `query` of one GraphQL request body. */
export interface GitHubGraphqlOperation {
  operationName: string;
  query: string;
}

function operation(document: DocumentNode): GitHubGraphqlOperation {
  const [definition] = document.definitions;
  if (definition?.kind !== Kind.OPERATION_DEFINITION || !definition.name) {
    throw new Error(
      "GitHub GraphQL document must start with a named operation",
    );
  }
  return { operationName: definition.name.value, query: print(document) };
}

function githubGraphql(source: string): GitHubGraphqlOperation {
  return operation(parse(source));
}

/** Add one reaction to a review body. */
export const ADD_REVIEW_REACTION = githubGraphql(`
  mutation AddReviewReaction($subjectId: ID!, $content: ReactionContent!) {
    addReaction(input: { subjectId: $subjectId, content: $content }) {
      reaction { content }
    }
  }
`);

/** Remove one reaction from a review body. */
export const REMOVE_REVIEW_REACTION = githubGraphql(`
  mutation RemoveReviewReaction($subjectId: ID!, $content: ReactionContent!) {
    removeReaction(input: { subjectId: $subjectId, content: $content }) {
      reaction { content }
    }
  }
`);

/** Read the reactions of a review body, with the bots that added them. */
export const REVIEW_REACTIONS = githubGraphql(`
  query ReviewReactions($subjectId: ID!) {
    node(id: $subjectId) {
      ... on PullRequestReview {
        reactionGroups {
          content
          reactors(first: 100) { nodes { ... on Bot { databaseId } } }
        }
      }
    }
  }
`);

// GitHub's REST API cannot change draft state; only these GraphQL mutations
// can. Both alias the mutation field to `result` so one schema reads either
// response.

/** Mark a draft pull request ready for review. */
export const MARK_PULL_REQUEST_READY_FOR_REVIEW = githubGraphql(`
  mutation MarkPullRequestReadyForReview($id: ID!) {
    result: markPullRequestReadyForReview(input: { pullRequestId: $id }) {
      pullRequest { isDraft }
    }
  }
`);

/** Convert a pull request to a draft. */
export const CONVERT_PULL_REQUEST_TO_DRAFT = githubGraphql(`
  mutation ConvertPullRequestToDraft($id: ID!) {
    result: convertPullRequestToDraft(input: { pullRequestId: $id }) {
      pullRequest { isDraft }
    }
  }
`);

/** Read a review thread with the pull request that owns it. */
export const REVIEW_THREAD_OWNERSHIP = githubGraphql(`
  query ReviewThreadOwnership($threadId: ID!) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        id
        isResolved
        pullRequest {
          number
          repository { nameWithOwner }
          author { ... on Bot { databaseId } }
        }
      }
    }
  }
`);

/** Resolve a review thread. */
export const RESOLVE_REVIEW_THREAD = githubGraphql(`
  mutation ResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`);

/**
 * Read the merge state of one pull request and the checks of its head
 * commit, with whether each check is required.
 */
export const PULL_REQUEST_CHECKS = githubGraphql(`
  query PullRequestChecks($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        mergeStateStatus
        reviewDecision
        autoMergeRequest { enabledAt }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun {
                      name
                      status
                      conclusion
                      isRequired(pullRequestNumber: $number)
                    }
                    ... on StatusContext {
                      context
                      state
                      isRequired(pullRequestNumber: $number)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`);

/**
 * Read the CODEOWNERS files and the root AGENTS.md of a base branch, and one
 * page of the files that a pull request changes. Each `*Expression` is
 * `<base>:<path>`.
 */
export const PULL_REQUEST_DRAFT_READINESS = githubGraphql(`
  query PullRequestDraftReadiness(
    $owner: String!
    $name: String!
    $number: Int!
    $githubExpression: String!
    $rootExpression: String!
    $docsExpression: String!
    $agentsExpression: String!
    $after: String
  ) {
    repository(owner: $owner, name: $name) {
      github: object(expression: $githubExpression) { ... on Blob { text } }
      root: object(expression: $rootExpression) { ... on Blob { text } }
      docs: object(expression: $docsExpression) { ... on Blob { text } }
      agents: object(expression: $agentsExpression) { ... on Blob { text } }
      pullRequest(number: $number) {
        files(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { path }
        }
      }
    }
  }
`);

/** Read one page of a pull request search, with mergeability. */
export const OPEN_PULL_REQUEST_MERGEABILITY = githubGraphql(`
  query OpenPullRequestMergeability($query: String!, $after: String) {
    search(query: $query, type: ISSUE, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest { number state isDraft mergeable headRefOid baseRefName title url }
      }
    }
  }
`);

/**
 * Read what decides a merge conflict fix on one pull request: the review
 * decision, when it opened, and its latest pushes, reviews, and comments.
 */
export const PULL_REQUEST_CONFLICT_HISTORY = githubGraphql(`
  query PullRequestConflictHistory($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        createdAt
        reviewDecision
        timelineItems(last: 100, itemTypes: [PULL_REQUEST_COMMIT, PULL_REQUEST_REVIEW, ISSUE_COMMENT, HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes {
            __typename
            ... on PullRequestCommit { commit { committedDate parents { totalCount } author { user { login } } } }
            ... on PullRequestReview { submittedAt author { __typename } }
            ... on IssueComment { createdAt author { __typename } }
            ... on HeadRefForcePushedEvent { createdAt actor { __typename } }
          }
        }
      }
    }
  }
`);

// The lifecycle query for one pull request. `pullRequestLifecycles` repeats
// its `pullRequest` field and `$number` variable for each pull request.
const PULL_REQUEST_LIFECYCLE = githubGraphql(`
  query PullRequestLifecycles($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      databaseId
      nameWithOwner
      pullRequest(number: $number) { ...Lifecycle }
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
`);

/**
 * Return the query that reads the lifecycle of `count` pull requests of one
 * repository. Pull request `i` has the alias `pr<i>` and the variable `$n<i>`.
 */
export function pullRequestLifecycles(count: number): GitHubGraphqlOperation {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variable = (index: number): VariableNode => ({
    kind: Kind.VARIABLE,
    name: { kind: Kind.NAME, value: `n${index}` },
  });
  return operation(
    visit(parse(PULL_REQUEST_LIFECYCLE.query), {
      OperationDefinition: (node) => ({
        ...node,
        variableDefinitions: node.variableDefinitions?.flatMap((definition) =>
          definition.variable.name.value === "number"
            ? indexes.map((index) => ({
                ...definition,
                variable: variable(index),
              }))
            : [definition],
        ),
      }),
      SelectionSet: (node) => ({
        ...node,
        selections: node.selections.flatMap((selection): SelectionNode[] =>
          selection.kind === Kind.FIELD &&
          selection.name.value === "pullRequest"
            ? indexes.map((index) => ({
                ...selection,
                alias: { kind: Kind.NAME, value: `pr${index}` },
                arguments: selection.arguments?.map((argument) => ({
                  ...argument,
                  value: variable(index),
                })),
              }))
            : [selection],
        ),
      }),
    }),
  );
}
