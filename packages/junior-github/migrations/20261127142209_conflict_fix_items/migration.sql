-- The merge conflict policy now reads Resumes from the item history, and a
-- fix that a Resume started names its item. Name the item on the fix of
-- each saved Resume: the fix that started at `conflict_fixes_resumed_at`,
-- and the latest item of the pull request that a Resume closed by then.
-- junior:bounded-backfill: only the Junior pull requests with a saved Resume, one row each, written once.
UPDATE junior_github_pull_requests AS pull_request
SET conflict_fixes = coalesce((
  SELECT jsonb_agg(
    CASE
      WHEN (fixes.fix ->> 'atMs')::numeric = round(extract(epoch FROM pull_request.conflict_fixes_resumed_at) * 1000)
        THEN fixes.fix || jsonb_build_object('itemId', resumed.item_id)
      ELSE fixes.fix
    END
    ORDER BY fixes.position
  )
  FROM jsonb_array_elements(pull_request.conflict_fixes) WITH ORDINALITY AS fixes(fix, position)
), '[]'::jsonb)
FROM (
  SELECT DISTINCT ON (item.subject_id)
    item.subject_id,
    item.id AS item_id
  FROM junior_inbox_items AS item
  JOIN junior_github_pull_requests AS saved
    ON saved.pull_request_id = item.subject_id
  WHERE item.subject_kind = 'github:merge_conflict'
    AND item.status = 'done'
    AND item.answer -> 'values' -> 'choice' ->> 0 = 'Resume'
    AND item.closed_at <= saved.conflict_fixes_resumed_at
  ORDER BY item.subject_id, item.closed_at DESC
) AS resumed
WHERE resumed.subject_id = pull_request.pull_request_id;
