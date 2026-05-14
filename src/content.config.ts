import { defineCollection, z } from "astro:content";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    schema: docsSchema({
      extend: z.object({
        phase: z.string().optional(),
        domain: z.string().optional(),
        difficulty: z.string().optional(),
        owner: z.string().optional(),
        order: z.number().optional(),
      }),
    }),
  }),
};
