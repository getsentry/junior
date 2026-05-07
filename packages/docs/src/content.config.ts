import { defineCollection, z } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    schema: docsSchema({
      extend: z.object({
        type: z
          .enum(["conceptual", "tutorial", "reference", "troubleshooting"])
          .optional(),
        prerequisites: z.array(z.string()).optional(),
        related: z.array(z.string()).optional(),
      }),
    }),
  }),
};
