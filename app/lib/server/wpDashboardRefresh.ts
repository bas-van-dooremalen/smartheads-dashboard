import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "../firebaseAdmin";

const FETCH_TIMEOUT_MS = 60_000;
const REACHABILITY_TIMEOUT_MS = 20_000;

type Reachability = {
  ok: boolean;
  url: string;
  statusCode: number | null;
  statusText: string | null;
  responseTimeMs: number;
  checkedAt: number;
  error: string | null;
};

type WpFetchResult = {
  data: unknown | null;
  ok: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  error: string | null;
  host: string;
};

const HttpCheckSchema = z
  .object({
    url: z.string(),
    post_id: z.number().nullable(),
    status_code: z.number(),
    status_text: z.string(),
    response_time_ms: z.number(),
    ok: z.boolean(),
    is_redirect: z.boolean(),
    is_error: z.boolean(),
  })
  .passthrough();

const WpSiteDataSchema = z
  .object({
    site: z.string().optional(),
    php: z.string().optional(),
    core: z
      .object({ current: z.string(), needs_update: z.boolean() })
      .passthrough()
      .optional(),
    plugins: z
      .array(z.object({ name: z.string(), needs_update: z.boolean() }).passthrough())
      .optional()
      .default([]),
    themes: z
      .array(z.object({ name: z.string(), needs_update: z.boolean() }).passthrough())
      .optional()
      .default([]),
    http_health: z
      .object({
        has_errors: z.boolean(),
        error_count: z.number(),
        total_checked: z.number(),
        checks: z.array(HttpCheckSchema).optional().default([]),
      })
      .passthrough()
      .optional(),
    ssl: z
      .object({
        valid: z.boolean(),
        days_remaining: z.number().nullable(),
        expiry_date: z.string().nullable(),
        status: z.enum(["ok", "critical", "error"]),
        message: z.string(),
      })
      .passthrough()
      .optional(),
    offline_log: z
      .object({
        total_events: z.number(),
        events: z
          .array(
            z
              .object({
                url: z.string(),
                timestamp: z.number(),
                date: z.string(),
                status_code: z.number(),
                reason: z.string(),
              })
              .passthrough()
          )
          .optional()
          .default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let hostname = trimmed;
  if (trimmed.includes("://")) {
    try {
      hostname = new URL(trimmed).hostname;
    } catch {
      return null;
    }
  } else {
    hostname = trimmed.split("/")[0] ?? "";
  }

  hostname = hostname.toLowerCase();
  if (hostname === "localhost") return null;
  if (hostname.endsWith(".local")) return null;
  if (!hostname.includes(".")) return null;

  const ipv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4.test(hostname)) return null;
  if (hostname.includes(":")) return null;

  const fqdn =
    /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
  if (!fqdn.test(hostname)) return null;

  return hostname;
}

function normalizeErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const base = (e.message || e.name || "error").trim();
    const anyErr = e as any;
    const cause = anyErr?.cause;

    // Node/undici often throws "TypeError: fetch failed" with a useful cause code.
    const causeParts: string[] = [];
    if (cause && typeof cause === "object") {
      const causeCode =
        typeof (cause as any).code === "string" ? (cause as any).code : null;
      const causeMessage =
        typeof (cause as any).message === "string"
          ? (cause as any).message
          : null;

      if (causeCode) causeParts.push(causeCode);
      if (causeMessage && causeMessage !== base) causeParts.push(causeMessage);
    } else if (typeof cause === "string" && cause !== base) {
      causeParts.push(cause);
    }

    const msg = causeParts.length ? `${base} (${causeParts.join(": ")})` : base;
    return msg.length > 250 ? msg.slice(0, 250) : msg;
  }
  const msg = String(e ?? "error").trim();
  return msg.length > 250 ? msg.slice(0, 250) : msg;
}

async function checkSiteReachability(domain: string): Promise<Reachability> {
  const hosts = domain.startsWith("www.") ? [domain] : [domain, `www.${domain}`];
  let lastFailure: Reachability | null = null;

  for (const host of hosts) {
    const url = `https://${host}/`;
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": "Smartheads-Dashboard-Monitor/3.0",
          accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      // We only care that the server responds; don't download the whole page.
      try {
        await res.body?.cancel();
      } catch {
        // Ignore.
      }

      const responseTimeMs = Date.now() - start;
      const statusCode = typeof res.status === "number" ? res.status : null;
      const result: Reachability = {
        ok: statusCode !== null ? statusCode < 500 : false,
        url,
        statusCode,
        statusText: res.statusText || null,
        responseTimeMs,
        checkedAt: Date.now(),
        error: null,
      };

      // If we got any response, accept it; a 4xx still proves reachability.
      return result;
    } catch (e: unknown) {
      const responseTimeMs = Date.now() - start;
      const name = e instanceof Error ? e.name : "";
      const error = name === "AbortError" ? "timeout" : normalizeErrorMessage(e);
      lastFailure = {
        ok: false,
        url,
        statusCode: null,
        statusText: null,
        responseTimeMs,
        checkedAt: Date.now(),
        error,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return (
    lastFailure ?? {
      ok: false,
      url: `https://${domain}/`,
      statusCode: null,
      statusText: null,
      responseTimeMs: 0,
      checkedAt: Date.now(),
      error: "unknown",
    }
  );
}

export async function fetchWpSiteData(domain: string) {
  const apiKey = process.env.WP_DASHBOARD_API_KEY;
  if (!apiKey) throw new Error("Missing WP_DASHBOARD_API_KEY");

  const hosts = domain.startsWith("www.") ? [domain] : [domain, `www.${domain}`];
  let last: WpFetchResult | null = null;

  for (const host of hosts) {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://${host}/wp-json/dashboard/v1/updates?key=${encodeURIComponent(apiKey)}&_=${Date.now()}`,
        { cache: "no-store", signal: controller.signal }
      );
      const responseTimeMs = Date.now() - start;
      if (!res.ok) {
        last = {
          data: null,
          ok: false,
          statusCode: res.status,
          responseTimeMs,
          error: `http_${res.status}`,
          host,
        };
        continue;
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        last = {
          data: null,
          ok: false,
          statusCode: res.status,
          responseTimeMs,
          error: "invalid_json",
          host,
        };
        continue;
      }

      const parsed = WpSiteDataSchema.safeParse(json);
      if (!parsed.success) {
        last = {
          data: null,
          ok: false,
          statusCode: res.status,
          responseTimeMs,
          error: "schema_mismatch",
          host,
        };
        continue;
      }

      return {
        data: parsed.data,
        ok: true,
        statusCode: res.status,
        responseTimeMs,
        error: null,
        host,
      };
    } catch (e: unknown) {
      const responseTimeMs = Date.now() - start;
      const name = e instanceof Error ? e.name : "";
      const error = name === "AbortError" ? "timeout" : normalizeErrorMessage(e);
      last = {
        data: null,
        ok: false,
        statusCode: null,
        responseTimeMs,
        error,
        host,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  return (
    last ?? {
      data: null,
      ok: false,
      statusCode: null,
      responseTimeMs: 0,
      error: "unknown",
      host: domain,
    }
  );
}

export async function upsertWpSiteByDomain(domain: string) {
  const wpSites = adminDb.collection("wpSites");
  const existing = await wpSites.where("domain", "==", domain).limit(1).get();

  const reachability = await checkSiteReachability(domain);

  const wp = await fetchWpSiteData(domain);

  const payload: Record<string, unknown> = {
    domain,
    lastChecked: FieldValue.serverTimestamp(),
    ok: reachability.ok,
    status: reachability.ok ? "online" : "offline",
    reachability,
    lastWpFetchOk: wp.ok,
    lastWpFetchError: wp.error,
    lastWpFetchStatusCode: wp.statusCode,
    lastWpFetchResponseTimeMs: wp.responseTimeMs,
    lastWpFetchHost: wp.host,
    lastWpFetchAt: FieldValue.serverTimestamp(),
  };

  if (wp.data) {
    payload.lastData = wp.data;
  }

  if (existing.empty) {
    await wpSites.add(payload);
    return { domain, created: true, ok: reachability.ok };
  }

  await existing.docs[0]!.ref.set(payload, { merge: true });
  return { domain, created: false, ok: reachability.ok };
}
