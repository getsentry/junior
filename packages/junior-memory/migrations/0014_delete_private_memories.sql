-- All memory is public. Delete the legacy private memories. Their embeddings
-- and signals go with them through ON DELETE CASCADE. 'personal' is the label
-- from before the scope rename.
DELETE FROM junior_memory_memories WHERE scope IN ('private', 'personal');
