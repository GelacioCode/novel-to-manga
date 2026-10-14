import { z } from "zod";

export const adaptationSchema = z.object({
  passages: z.array(z.object({ id: z.string(), text: z.string() })),
  events: z.array(z.object({ id: z.string(), summary: z.string(), passageIds: z.array(z.string()) })),
  characters: z.array(z.object({ name: z.string(), role: z.string(), inferredDesign: z.boolean() })),
  locations: z.array(z.string()),
  continuityChanges: z.array(z.string()),
  pages: z.array(z.object({
    pageNumber: z.number().int().positive(),
    panels: z.array(z.object({ sourcePassageIds: z.array(z.string()), description: z.string(), dialogue: z.array(z.object({ speaker: z.string(), text: z.string() })) }))
  }))
});
export type Adaptation = z.infer<typeof adaptationSchema>;

export const jobOptionsSchema = z.object({
  chapterId: z.string().min(1),
  mode: z.enum(["faithful", "condensed"]).default("faithful"),
  pageMin: z.number().int().min(1).max(100).default(4),
  pageMax: z.number().int().min(1).max(100).default(8),
  sampleOnly: z.boolean().default(true),
  paidCallsAuthorized: z.boolean().default(false)
}).refine(x => x.pageMax >= x.pageMin, "pageMax must be at least pageMin");

export const bulkImportSchema = z.object({
  chapters: z.array(z.object({ identifier: z.string().min(1), title: z.string().min(1), sourceText: z.string().min(1), mappingNote: z.string().default(""), sourceKind: z.enum(["paste", "txt"]).default("paste"), sourceMetadata: z.record(z.string(), z.string()).default({}) })).min(1)
});
