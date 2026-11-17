import { customType } from "drizzle-orm/pg-core";

function pgvectorColumn(dataType: "vector" | "halfvec") {
  return customType<{ data: number[]; driverData: string }>({
    dataType() {
      return dataType;
    },
    toDriver(value) {
      return JSON.stringify(value);
    },
    fromDriver(value) {
      return value.slice(1, -1).split(",").map(Number);
    },
  });
}

/**
 * pgvector column without a fixed size, so a change of embedding model needs
 * no migration. Each table records the size of each row in its own column.
 */
export const vector = pgvectorColumn("vector");

/**
 * Half-precision `vector`: 2 bytes per value instead of 4, for tables that
 * hold one vector per event.
 */
export const halfvec = pgvectorColumn("halfvec");
