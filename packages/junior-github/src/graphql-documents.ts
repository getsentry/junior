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

/**
 * Read whether GitHub asks one person to review a pull request, and their
 * latest 20 submitted reviews. A pending review is not submitted.
 */
export const PULL_REQUEST_REVIEWER = githubGraphql(`
  query PullRequestReviewer($owner: String!, $name: String!, $number: Int!, $login: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewRequests(first: 100) {
          nodes { requestedReviewer { __typename ... on User { login } } }
        }
        reviews(last: 20, author: $login, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
          nodes { state }
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
 * Pushes have their own window, so comments, which anyone can add, cannot
 * push a person's latest push out of it.
 */
export const PULL_REQUEST_CONFLICT_HISTORY = githubGraphql(`
  query PullRequestConflictHistory($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        createdAt
        reviewDecision
        pushes: timelineItems(last: 100, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT]) {
          nodes {
            __typename
            ... on PullRequestCommit { commit { committedDate author { user { login } } } }
            ... on HeadRefForcePushedEvent { createdAt actor { __typename } }
          }
        }
        discussion: timelineItems(last: 50, itemTypes: [PULL_REQUEST_REVIEW, ISSUE_COMMENT]) {
          nodes {
            __typename
            ... on PullRequestReview { submittedAt author { __typename } }
            ... on IssueComment { createdAt author { __typename } }
          }
        }
      }
    }
  }
`);

/**
 * Read what decides the requester's next action on one pull request: its
 * state, merge state, review requests, latest reviews, and latest comments
 * and review requests. A review comment reply is a review, so `reviews`
 * holds it too.
 */
export const PULL_REQUEST_NEXT_ACTION = githubGraphql(`
  query PullRequestNextAction($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        autoMergeRequest { enabledAt }
        commits(last: 1) { nodes { commit { committedDate } } }
        isDraft
        mergeStateStatus
        state
        title
        url
        reviewRequests(first: 100) {
          nodes { requestedReviewer { __typename ... on User { login } } }
        }
        reviews(last: 100) {
          pageInfo { hasPreviousPage startCursor }
          nodes { ...NextActionReview }
        }
        timelineItems(last: 100, itemTypes: [ISSUE_COMMENT, REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT]) {
          nodes {
            __typename
            ... on IssueComment { createdAt author { __typename login } }
            ... on ReviewRequestedEvent {
              createdAt
              requestedReviewer { __typename ... on User { login } }
            }
            ... on ReviewRequestRemovedEvent {
              createdAt
              actor { __typename login }
              requestedReviewer { __typename ... on User { login } }
            }
          }
        }
      }
    }
  }

  fragment NextActionReview on PullRequestReview {
    state
    submittedAt
    author { __typename login }
  }
`);

/**
 * Read whether the required checks of a pull request's head commit pass:
 * the checks of the head commit and the branch protection's required checks
 * of the base branch. `PULL_REQUEST_REVIEW_AGAIN` reads the same fields.
 */
export const PULL_REQUEST_REQUIRED_CHECKS = githubGraphql(`
  query PullRequestRequiredChecks($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        baseRefName
        baseRef { refUpdateRule { requiredStatusCheckContexts } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
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
 * Read what decides whether a reviewer's change request is ready for their
 * review again: whether GitHub asks them, when GitHub last asked people for
 * a review, their latest 20 reviews with the reactors of each body and
 * comment, the checks of the head
 * commit, and the branch protection's required checks of the base branch.
 */
export const PULL_REQUEST_REVIEW_AGAIN = githubGraphql(`
  query PullRequestReviewAgain($owner: String!, $name: String!, $number: Int!, $reviewer: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        baseRefName
        baseRef { refUpdateRule { requiredStatusCheckContexts } }
        reviewRequests(first: 100) {
          nodes { requestedReviewer { __typename ... on User { login } } }
        }
        timelineItems(last: 100, itemTypes: [REVIEW_REQUESTED_EVENT]) {
          nodes {
            ... on ReviewRequestedEvent {
              createdAt
              requestedReviewer { __typename ... on User { login } }
            }
          }
        }
        reviews(last: 20, author: $reviewer, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
          nodes {
            databaseId
            state
            submittedAt
            body
            ...FeedbackReactors
            comments(first: 100) {
              totalCount
              nodes { databaseId ...FeedbackReactors }
            }
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  pageInfo { hasNextPage }
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  fragment FeedbackReactors on Reactable {
    reactionGroups {
      content
      reactors(first: 100) { nodes { ... on Bot { databaseId } } }
    }
  }
`);

/** Read the page of a pull request's reviews before `before`. */
export const PULL_REQUEST_REVIEWS_BEFORE = githubGraphql(`
  query PullRequestReviewsBefore($owner: String!, $name: String!, $number: Int!, $before: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(last: 100, before: $before) {
          pageInfo { hasPreviousPage startCursor }
          nodes { ...NextActionReview }
        }
      }
    }
  }

  fragment NextActionReview on PullRequestReview {
    state
    submittedAt
    author { __typename login }
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
                arguments: (selection.arguments ?? []).map((argument) => ({
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

// The card fields of one pull request. `pullRequestCards` repeats its
// `repository` field and variables for each pull request.
const PULL_REQUEST_CARD = githubGraphql(`
  query PullRequestCards($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { ...Card }
    }
  }

  fragment Card on PullRequest {
    url
    number
    state
    title
    body
    updatedAt
    author { login }
    isDraft
    merged
    headRefName
    headRefOid
    baseRefName
    mergeable
    additions
    deletions
    changedFiles
    reviewRequests(first: 5) {
      nodes {
        requestedReviewer {
          ... on User { login }
          ... on Bot { login }
        }
      }
    }
    reviewDecision
    latestOpinionatedReviews(first: 5, writersOnly: true) {
      nodes { state }
    }
    commits(last: 1) {
      nodes {
        commit {
          statusCheckRollup {
            contexts(first: 1) {
              checkRunCountsByState { state count }
            }
          }
        }
      }
    }
  }
`);

// Only the merge state and check counts of one pull request, for the patch
// after a push. `pullRequestHeadFacts` repeats it like the cards.
const PULL_REQUEST_HEAD_FACT = githubGraphql(`
  query PullRequestHeadFacts($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { ...HeadFacts }
    }
  }

  fragment HeadFacts on PullRequest {
    updatedAt
    headRefOid
    mergeable
    commits(last: 1) {
      nodes {
        commit {
          statusCheckRollup {
            contexts(first: 1) {
              checkRunCountsByState { state count }
            }
          }
        }
      }
    }
  }
`);

// Repeat the `repository` field and the variables of a one pull request
// query `count` times. Pull request `i` has the alias `p<i>` and the
// variables `$owner<i>`, `$name<i>`, and `$number<i>`.
function aliasedPullRequests(
  single: GitHubGraphqlOperation,
  count: number,
): GitHubGraphqlOperation {
  const document = parse(single.query);
  const indexes = Array.from({ length: count }, (_, index) => index);
  const indexed = (variable: VariableNode, index: number): VariableNode => ({
    ...variable,
    name: { kind: Kind.NAME, value: `${variable.name.value}${index}` },
  });
  return operation({
    ...document,
    definitions: document.definitions.map((definition) =>
      definition.kind === Kind.OPERATION_DEFINITION
        ? {
            ...definition,
            variableDefinitions: indexes.flatMap((index) =>
              (definition.variableDefinitions ?? []).map((variable) => ({
                ...variable,
                variable: indexed(variable.variable, index),
              })),
            ),
            selectionSet: {
              ...definition.selectionSet,
              selections: indexes.flatMap((index) =>
                definition.selectionSet.selections.map((selection) => {
                  const renamed = visit(selection, {
                    Variable: (variable) => indexed(variable, index),
                  });
                  return renamed.kind === Kind.FIELD
                    ? {
                        ...renamed,
                        alias: { kind: Kind.NAME, value: `p${index}` },
                      }
                    : renamed;
                }),
              ),
            },
          }
        : definition,
    ),
  });
}

/**
 * Return the query that reads the cards of `count` pull requests by
 * repository and number, with the aliases and variables of
 * `pullRequestVariables`. The check run counts are of each head commit.
 * The App has no commit status permission, so statuses do not count.
 */
export function pullRequestCards(count: number): GitHubGraphqlOperation {
  return aliasedPullRequests(PULL_REQUEST_CARD, count);
}

/**
 * Return the query that reads only the merge state and check counts of
 * `count` pull requests by repository and number, for the patch after a
 * push. It has the aliases and variables of `pullRequestCards`.
 */
export function pullRequestHeadFacts(count: number): GitHubGraphqlOperation {
  return aliasedPullRequests(PULL_REQUEST_HEAD_FACT, count);
}
