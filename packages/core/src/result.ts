import { randomUUID } from "node:crypto";
import type { ResultEnvelope } from "@jianzuo/contracts";

export function result<T>(status: ResultEnvelope<T>["status"], summary: string, data?: T): ResultEnvelope<T> {
  return {
    status,
    summary,
    ...(data === undefined ? {} : { data }),
    nextActions: [],
    artifacts: [],
    correlationId: randomUUID()
  };
}

