import type { ResultEnvelope } from "@jianzuo/contracts";

let csrfToken = "";

export function setCsrfToken(token: string): void { csrfToken = token; }
export function clearCsrfToken(): void { csrfToken = ""; }

export class ApiError extends Error {
  constructor(message: string, readonly statusCode: number, readonly envelope?: ResultEnvelope<unknown>) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<ResultEnvelope<T>> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && csrfToken) headers.set("x-jianzuo-csrf", csrfToken);
  const response = await fetch(path, { ...init, headers, credentials: "include" });
  const envelope = await response.json() as ResultEnvelope<T>;
  if (response.status === 401) window.dispatchEvent(new CustomEvent("jianzuo:locked"));
  if (!response.ok) throw new ApiError(envelope.summary || "请求失败", response.status, envelope as ResultEnvelope<unknown>);
  return envelope;
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}

export function formatMoney(value: number | null | undefined): string {
  return `¥${Number(value ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: Number(value) % 1 ? 1 : 0, maximumFractionDigits: 2 })}`;
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

