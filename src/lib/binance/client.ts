import { createHmac } from "node:crypto";
import { FUTURES_BASE_URL, RECV_WINDOW, requireCredentials } from "@/lib/config";

/** A structured Binance error. `code` is the Binance error code, e.g. -4146. */
export class BinanceApiError extends Error {
  constructor(
    readonly code: number,
    readonly binanceMessage: string,
    readonly httpStatus: number,
    readonly endpoint: string,
  ) {
    super(`Binance ${endpoint} failed [${code}]: ${binanceMessage}`);
    this.name = "BinanceApiError";
  }

  /**
   * -4146: "Order's notional must be no smaller than x (unless you choose
   * reduce-only)". Guardian reductions are reduce-only and therefore exempt, so
   * seeing this on a reduction means reduceOnly was lost somewhere.
   */
  get isMinNotional(): boolean {
    return this.code === -4146 || this.code === -1013;
  }

  /** -2019: margin is insufficient. -2022: ReduceOnly order is rejected. */
  get isReduceOnlyRejected(): boolean {
    return this.code === -2022;
  }
}

type Params = Record<string, string | number | boolean | undefined>;

/** Drops undefined values and stringifies the rest, preserving insertion order. */
function toQuery(params: Params): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${key}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

/**
 * Local clock drift against Binance, in ms. Signed requests carry a timestamp
 * and are rejected with -1021 if it is outside recvWindow, so we correct for a
 * skewed local clock rather than hoping it is accurate.
 */
let clockOffsetMs = 0;
let clockSyncedAt = 0;

export async function syncClock(): Promise<number> {
  const before = Date.now();
  const { serverTime } = await publicGet<{ serverTime: number }>("/fapi/v1/time");
  const after = Date.now();
  // Assume symmetric latency: the server read the clock mid-flight.
  clockOffsetMs = serverTime - Math.round((before + after) / 2);
  clockSyncedAt = after;
  return clockOffsetMs;
}

async function timestamp(): Promise<number> {
  // Re-sync every 30 minutes; cheap insurance against long-running drift.
  if (clockSyncedAt === 0 || Date.now() - clockSyncedAt > 30 * 60_000) {
    await syncClock();
  }
  return Date.now() + clockOffsetMs;
}

async function request<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  query: string,
  headers: Record<string, string>,
  baseUrl: string = FUTURES_BASE_URL,
): Promise<T> {
  const url = query ? `${baseUrl}${path}?${query}` : `${baseUrl}${path}`;
  const response = await fetch(url, { method, headers, cache: "no-store" });
  const text = await response.text();

  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new BinanceApiError(0, `non-JSON response: ${text.slice(0, 200)}`, response.status, path);
  }

  if (!response.ok) {
    const err = body as { code?: number; msg?: string } | null;
    throw new BinanceApiError(
      err?.code ?? 0,
      err?.msg ?? `HTTP ${response.status}`,
      response.status,
      path,
    );
  }
  return body as T;
}

/** Unauthenticated market-data call. */
export async function publicGet<T>(path: string, params: Params = {}): Promise<T> {
  return request<T>("GET", path, toQuery(params), {});
}

/**
 * Signed call against the execution account. Every param is HMAC-SHA256 signed
 * with the API secret; the signature must be the final query parameter.
 */
export async function signedRequest<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Params = {},
  /** Overrides the futures host — the spot host serves key-permission checks. */
  baseUrl: string = FUTURES_BASE_URL,
): Promise<T> {
  const { apiKey, apiSecret } = requireCredentials();
  const query = toQuery({
    ...params,
    recvWindow: RECV_WINDOW,
    timestamp: await timestamp(),
  });
  const signature = createHmac("sha256", apiSecret).update(query).digest("hex");

  return request<T>(
    method,
    path,
    `${query}&signature=${signature}`,
    { "X-MBX-APIKEY": apiKey },
    baseUrl,
  );
}
