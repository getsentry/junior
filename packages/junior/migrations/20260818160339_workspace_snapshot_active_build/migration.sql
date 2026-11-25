CREATE UNIQUE INDEX "junior_snapshots_active_build_uidx" ON "junior_snapshots" USING btree ("workspace_id","profile_hash") WHERE "junior_snapshots"."status" = 'building';
