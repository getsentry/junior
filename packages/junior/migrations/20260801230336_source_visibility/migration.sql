UPDATE "junior_conversations"
SET "source_json" = ("source_json" - 'type') || jsonb_build_object(
  'visibility', CASE "source_json" ->> 'type'
    WHEN 'pub' THEN 'public'
    WHEN 'priv' THEN 'private'
  END
)
WHERE "source_json" ->> 'type' IN ('pub', 'priv');
