import { customType } from "drizzle-orm/pg-core";

/**
 * pgvector column without a fixed size, so a change of embedding model needs
 * no migration. Each table records the size of each row in its own column.
 */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value) {
    return JSON.stringify(value);
  },
  fromDriver(value) {
    return value.slice(1, -1).split(",").map(Number);
  },
});
