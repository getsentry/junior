CREATE INDEX "junior_memory_embeddings_embedding_hnsw_idx" ON "junior_memory_embeddings" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16,ef_construction=64);
