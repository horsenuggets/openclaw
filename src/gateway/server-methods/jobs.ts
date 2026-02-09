import type { JobListParams } from "../job-tracker.js";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export const jobsHandlers: GatewayRequestHandlers = {
  "jobs.list": ({ params, respond, context }) => {
    const listParams: JobListParams = {};
    if (typeof params?.status === "string") {
      listParams.status = params.status;
    } else if (Array.isArray(params?.status)) {
      listParams.status = params.status.filter((s): s is string => typeof s === "string");
    }
    if (typeof params?.channel === "string") {
      listParams.channel = params.channel;
    }
    if (typeof params?.limit === "number") {
      listParams.limit = Math.max(1, Math.min(500, params.limit));
    }
    if (typeof params?.includeCompleted === "boolean") {
      listParams.includeCompleted = params.includeCompleted;
    }
    if (typeof params?.hideHeartbeats === "boolean") {
      listParams.hideHeartbeats = params.hideHeartbeats;
    }
    const result = context.jobTracker.list(listParams);
    respond(true, result, undefined);
  },

  "jobs.get": ({ params, respond, context }) => {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    if (!runId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "runId is required"));
      return;
    }
    const job = context.jobTracker.get(runId);
    if (!job) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `job not found: ${runId}`));
      return;
    }
    respond(true, { job }, undefined);
  },
};
