export type JobStatus = "active" | "completed" | "failed";

export type JobEntry = {
  jobId: string;
  userId: string;
  sessionKey: string;
  prompt: string;
  summary?: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
};

export type JobEvent = {
  ts: number;
  jobId: string;
  event: "created" | "message" | "completed" | "failed";
  data?: Record<string, unknown>;
};

export type JobClassification = {
  decision: "NEW" | "CONTINUE";
  reason?: string;
};

export type JobClassifierConfig = {
  /** Enable Haiku-based topic classification. Default: true. */
  enabled?: boolean;
  /** Model to use for classification. Default: haiku. */
  model?: string;
  /** Timeout for classification in ms. Default: 8000. */
  timeoutMs?: number;
};

export type JobsConfig = {
  /** Enable job tracking with smart routing. Default: true for DMs. */
  enabled?: boolean;
  /** Classifier settings. */
  classifier?: JobClassifierConfig;
  /** Archive completed jobs after N ms. Default: 86400000 (24h). */
  archiveAfterMs?: number;
  /** Prune archived jobs after N ms. Default: 604800000 (7d). */
  pruneAfterMs?: number;
};
