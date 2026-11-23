/**
 * Stored columns that the provider state check allows, as `table.column`
 * with the reason. GitHub is the source of truth for GitHub state
 * (`design/github.md`), so a column here is one of:
 *
 * - Junior-owned: a fact that Junior decides or records, or a key for one.
 * - Too expensive to derive: a value that a read needs for many objects at
 *   once, which GitHub cannot give at that cost.
 * - Mirror awaiting cleanup: a copy of GitHub state that a cleanup removes.
 *
 * Only the owner adds an entry. Remove an entry when its column is dropped.
 */
export const githubStateExceptions = {
  "junior_code_changes.additions":
    "Mirror awaiting cleanup: cards read the size through object-link resolve.",
  "junior_code_changes.changed_files":
    "Mirror awaiting cleanup: cards read the size through object-link resolve.",
  "junior_code_changes.closed_at":
    "Too expensive to derive: the Code pages filter and count code changes by state.",
  "junior_code_changes.deletions":
    "Mirror awaiting cleanup: cards read the size through object-link resolve.",
  "junior_code_changes.draft":
    "Mirror awaiting cleanup: cards read the draft state through object-link resolve.",
  "junior_code_changes.merged_at":
    "Too expensive to derive: the Code pages filter and count code changes by state.",
  "junior_code_changes.state":
    "Too expensive to derive: the Code pages filter and count code changes by state.",
  "junior_code_changes.title":
    "Too expensive to derive: search matches code changes by title.",

  "junior_github_pull_request_issues.pull_request_id":
    "Mirror awaiting cleanup: nothing reads it.",
  "junior_github_pull_request_issues.issue_repository_full_name":
    "Mirror awaiting cleanup: nothing reads it.",
  "junior_github_pull_request_issues.issue_number":
    "Mirror awaiting cleanup: nothing reads it.",

  "junior_github_pull_request_requesters.repository_full_name":
    "Junior-owned: the key of the person who asked Junior for the pull request.",
  "junior_github_pull_request_requesters.number":
    "Junior-owned: the key of the person who asked Junior for the pull request.",
  "junior_github_pull_request_requesters.identity_id":
    "Junior-owned: the person who asked Junior for the pull request.",
  "junior_github_pull_request_requesters.conversation_id":
    "Junior-owned: the Conversation where the person asked.",
  "junior_github_pull_request_requesters.created_at":
    "Junior-owned: when the person asked.",
  "junior_github_pull_request_requesters.updated_at":
    "Junior-owned: when the person last asked.",

  "junior_github_pull_requests.pull_request_id":
    "Junior-owned: the key of the facts that Junior records for its pull request.",
  "junior_github_pull_requests.repository_id":
    "Mirror awaiting cleanup: core code changes hold the repository.",
  "junior_github_pull_requests.repository_full_name":
    "Mirror awaiting cleanup: core code changes hold the repository.",
  "junior_github_pull_requests.number":
    "Mirror awaiting cleanup: core code changes hold the number.",
  "junior_github_pull_requests.state":
    "Mirror awaiting cleanup: core code changes hold the lifecycle.",
  "junior_github_pull_requests.opened_at":
    "Mirror awaiting cleanup: core code changes hold the lifecycle.",
  "junior_github_pull_requests.finished_at":
    "Mirror awaiting cleanup: core code changes hold the lifecycle.",
  "junior_github_pull_requests.commit_composition":
    "Too expensive to derive: it needs every commit of the pull request.",
  "junior_github_pull_requests.conversation_ids":
    "Junior-owned: the Conversations that worked on the pull request.",
  "junior_github_pull_requests.updated_at":
    "Junior-owned: when Junior last wrote the row.",
  "junior_github_pull_requests.next_action":
    "Junior-owned: the requester action that Junior shows in the Inbox.",
  "junior_github_pull_requests.ready_sync_requests":
    "Junior-owned: the next action check that Junior runs.",
  "junior_github_pull_requests.ready_sync_id":
    "Junior-owned: the next action check that Junior runs.",
  "junior_github_pull_requests.ready_sync_at":
    "Junior-owned: the next action check that Junior runs.",
  "junior_github_pull_requests.conflict_fixes_resumed_at":
    "Junior-owned: when a person resumed Junior's merge conflict fixes.",
  "junior_github_pull_requests.conflict_fix_asked_at":
    "Junior-owned: when Junior asked to resume merge conflict fixes.",
  "junior_github_pull_requests.conflict_fixes":
    "Junior-owned: the merge conflict fixes that Junior started.",
};
