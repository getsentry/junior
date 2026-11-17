import { customType } from "drizzle-orm/pg-core";

/** Postgres full-text lexemes. Queries read them only through SQL. */
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});
