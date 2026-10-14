export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancel_requested" | "cancelled" | "uncertain";

export interface Series {
  id: string; title: string; description: string; createdAt: string; chapterCount: number;
  completedCount: number; guideApproved: boolean; readingChapterId?: string;
}
export interface Chapter {
  id: string; seriesId: string; identifier: string; title: string; sortOrder: number;
  sourceText: string; sourceKind: string; sourceMetadata?: Record<string,string>; mappingNote: string; status: "imported" | "generating" | "completed"; pageCount: number;
}
export interface ReferenceImage {
  id: string; seriesId: string; filename: string; filePath: string; mimeType: string;
  tags: string[]; sourceUrl?: string; chapterLabel?: string; maxReferenceChapter?: string;
}
export interface Guide { id: string; seriesId: string; content: string; approved: boolean; version: number; }
export interface Job {
  id: string; seriesId: string; chapterId: string; status: JobStatus; stage: string;
  completedPages: number; totalPages: number; mode: "faithful" | "condensed";
  pageMin: number; pageMax: number; sampleOnly: boolean; providerMode: "mock" | "openai" | "hybrid";
  imageProviderMode: "mock" | "openai";
  error?: string; createdAt: string; updatedAt: string;
}
export interface Page {
  id: string; chapterId: string; revision: number; pageNumber: number; imagePath: string;
  layout: PanelLayout[]; lettering: Lettering[]; approved: boolean;
}
export interface PanelLayout { id: string; x: number; y: number; width: number; height: number; sourcePassageIds: string[]; }
export interface Lettering { id: string; panelId: string; kind: "dialogue" | "caption"; speaker: string; text: string; x: number; y: number; width: number; height: number; }
