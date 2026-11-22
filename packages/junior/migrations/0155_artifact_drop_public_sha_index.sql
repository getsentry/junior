-- 0154 built the index that replaces this one, so an artifact upsert always
-- has a unique index to match.
DROP INDEX "junior_artifacts_public_sha_uidx";