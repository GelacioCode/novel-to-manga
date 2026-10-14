import "dotenv/config";
import path from "node:path";

export const config = {
  apiPort: Number(process.env.API_PORT ?? 4317),
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  providerMode: process.env.PROVIDER_MODE === "hybrid" ? "hybrid" as const : process.env.PROVIDER_MODE === "openai" ? "openai" as const : "mock" as const,
  allowPaidCalls: process.env.ALLOW_PAID_PROVIDER_CALLS === "true",
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 12) * 1024 * 1024,
  maxPages: Number(process.env.MAX_PAGES_PER_CHAPTER ?? 24),
  maxJobSpendUsd: Number(process.env.MAX_JOB_SPEND_USD ?? 0),
  openAITextModel: process.env.OPENAI_TEXT_MODEL ?? "gpt-5.6",
  openAIImageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2.5-flare"
};
