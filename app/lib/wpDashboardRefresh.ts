import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import net from "node:net";
import tls from "node:tls";
import { Agent } from "undici";
import { adminDb } from "./firebaseAdmin";

const FETCH_TIMEOUT_MS = 60_000;
const REACHABILITY_TIMEOUT_MS = 20_000;
const SSL_TIMEOUT_MS = 10_000;

const wpInsecureTls = process.env.WP_FETCH_INSECURE_TLS === "1";
const wpFetchDispatcher = wpInsecureTls
  ? new Agent({ connect: { rejectUnauthorized: false } })
  : undefined;

// =============================================================================
// Types
// =============================================================================

type Reachability = {
  ok: boolean;
  url: string;
  statusCode: number | null;
  statusText: string | null;
  responseTimeMs: number;
  checkedAt: number;
  error: string | null;
};

type SslResult = {
  valid: boolean;
  days_remaining: number | null;
  expiry_date: string | null;
  status: "ok" | "warning" | "critical" | "error";
  message: string;
};

type WpFetchResult = {
  data: unknown | null;
  ok: boolean;
  statusCode: number | null;
  responseTimeMs: number;
  error: string | null;
  host: string;
};

// =============================================================================
// Helpers
// =============================================================================

function checkTcpConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      try { socket.removeAllListeners(); socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function normalizeErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    const base = (e.message || e.name || "error").trim();
    const cause = (e as Error & { cause?: unknown }).cause;
    const causeParts: string[] = [];
    if (cause && typeof cause === "object") {
      const causeObj = cause as { code?: unknown; message?: unknown };
      const causeCode = typeof causeObj.code === "string" ? causeObj.code : null;
      const causeMessage = typeof causeObj.message === "string" ? causeObj.message : null;
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

// =============================================================================
// SSL check — uitgevoerd vanuit Next.js, niet vanuit WordPress
// =============================================================================

async function checkSsl(domain: string): Promise<SslResult> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({
        valid: false,
        days_remaining: null,
        expiry_date: null,
        status: "error",
        message: "SSL-check timeout.",
      });
    }, SSL_TIMEOUT_MS);

    const socket = tls.connect(
      { host: domain, port: 443, servername: domain, rejectUnauthorized: false },
      () => {
        clearTimeout(timeout);
        try {
          const cert = socket.getPeerCertificate();
          socket.destroy();

          if (!cert || !cert.valid_to) {
            return resolve({
              valid: false,
              days_remaining: null,
              expiry_date: null,
              status: "error",
              message: "Certificaat kon niet worden uitgelezen.",
            });
          }

          const expiryDate  = new Date(cert.valid_to);
          const now         = new Date();
          const msRemaining = expiryDate.getTime() - now.getTime();
          const daysRemaining = Math.ceil(msRemaining / (1000 * 60 * 60 * 24));
          const expiryStr   = expiryDate.toISOString().split("T")[0]!;
          const valid       = daysRemaining > 0;

          let status: SslResult["status"];
          let message: string;

          if (!valid) {
            status  = "critical";
            message = `Certificaat is verlopen op ${expiryStr}.`;
          } else if (daysRemaining <= 14) {
            status  = "critical";
            message = `Certificaat verloopt over ${daysRemaining} dagen (${expiryStr}) — vernieuwen!`;
          } else if (daysRemaining <= 30) {
            status  = "warning";
            message = `Certificaat verloopt over ${daysRemaining} dagen (${expiryStr}).`;
          } else {
            status  = "ok";
            message = `Certificaat geldig tot ${expiryStr} (${daysRemaining} dagen).`;
          }

          resolve({ valid, days_remaining: daysRemaining, expiry_date: expiryStr, status, message });
        } catch (e) {
          resolve({
            valid: false,
            days_remaining: null,
            expiry_date: null,
            status: "error",
            message: normalizeErrorMessage(e),
          });
        }
      }
    );

    socket.once("error", (e) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve({
        valid: false,
        days_remaining: null,
        expiry_date: null,
        status: "error",
        message: normalizeErrorMessage(e),
      });
    });
  });
}

// =============================================================================
// Zod schemas
// =============================================================================

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

const PhpSchema = z.union([
  z.object({
    version: z.string(),
    needs_update: z.boolean(),
    recommended: z.string(),
  }).passthrough(),
  z.string(),
]);

const WpSiteDataSchema = z
  .object({
    site: z.string().optional(),
    php: PhpSchema.optional(),
    core: z
      .object({
        current: z.string(),
        needs_update: z.boolean(),
        new_version: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    plugins: z
      .array(
        z.object({
          name: z.string(),
          needs_update: z.boolean(),
          version: z.string().optional(),
          new_version: z.string().nullable().optional(),
          active: z.boolean().optional(),
        }).passthrough()
      )
      .optional()
      .default([]),
    themes: z
      .array(
        z.object({
          name: z.string(),
          needs_update: z.boolean(),
          version: z.string().optional(),
          new_version: z.string().nullable().optional(),
          active: z.boolean().optional(),
        }).passthrough()
      )
      .optional()
      .default([]),
    summary: z
      .object({
        core_updates: z.number(),
        theme_updates: z.number(),
        plugin_updates: z.number(),
        total_updates: z.number(),
      })
      .optional(),
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
        status: z.enum(["ok", "warning", "critical", "error"]),
        message: z.string(),
      })
      .optional(),
    offline_log: z
      .object({
        total_events: z.number(),
        events: z
          .array(
            z.object({
              url: z.string(),
              timestamp: z.number(),
              date: z.string(),
              status_code: z.number(),
              reason: z.string(),
            }).passthrough()
          )
          .optional()
          .default([]),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

// =============================================================================
// normalizeDomain
// =============================================================================

export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let hostname = trimmed;
  if (trimmed.includes("://")) {
    try { hostname = new URL(trimmed).hostname; } catch { return null; }
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

  const fqdn = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
  if (!fqdn.test(hostname)) return null;

  return hostname;
}

// =============================================================================
// checkSiteReachability
// =============================================================================

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
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      try { await res.body?.cancel(); } catch { /* ignore */ }
      const responseTimeMs = Date.now() - start;
      const statusCode = typeof res.status === "number" ? res.status : null;
      return {
        ok: statusCode !== null ? statusCode < 400 : false,
        url,
        statusCode,
        statusText: res.statusText || null,
        responseTimeMs,
        checkedAt: Date.now(),
        error: null,
      };
    } catch (e: unknown) {
      const responseTimeMs = Date.now() - start;
      const name = e instanceof Error ? e.name : "";
      const error = name === "AbortError" ? "timeout" : normalizeErrorMessage(e);
      const tcpOk = await checkTcpConnect(host, 443, 5_000);
      if (tcpOk) {
        return { ok: true, url, statusCode: null, statusText: "tcp", responseTimeMs, checkedAt: Date.now(), error: null };
      }
      lastFailure = { ok: false, url, statusCode: null, statusText: null, responseTimeMs, checkedAt: Date.now(), error };
    } finally {
      clearTimeout(timeout);
    }
  }

  return lastFailure ?? {
    ok: false,
    url: `https://${domain}/`,
    statusCode: null,
    statusText: null,
    responseTimeMs: 0,
    checkedAt: Date.now(),
    error: "unknown",
  };
}

// =============================================================================
// fetchWpSiteData
// =============================================================================

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
        ({ cache: "no-store", signal: controller.signal, dispatcher: wpFetchDispatcher } as unknown as RequestInit)
      );
      const responseTimeMs = Date.now() - start;
      if (!res.ok) {
        last = { data: null, ok: false, statusCode: res.status, responseTimeMs, error: `http_${res.status}`, host };
        continue;
      }

      let json: unknown;
      try { json = await res.json(); } catch {
        last = { data: null, ok: false, statusCode: res.status, responseTimeMs, error: "invalid_json", host };
        continue;
      }

      const parsed = WpSiteDataSchema.safeParse(json);
      if (!parsed.success) {
        console.error("[wpDashboardRefresh] schema_mismatch for", host, parsed.error.flatten());
        last = { data: null, ok: false, statusCode: res.status, responseTimeMs, error: "schema_mismatch", host };
        continue;
      }

      return { data: parsed.data, ok: true, statusCode: res.status, responseTimeMs, error: null, host };
    } catch (e: unknown) {
      const responseTimeMs = Date.now() - start;
      const name = e instanceof Error ? e.name : "";
      const error = name === "AbortError" ? "timeout" : normalizeErrorMessage(e);
      last = { data: null, ok: false, statusCode: null, responseTimeMs, error, host };
    } finally {
      clearTimeout(timeout);
    }
  }

  return last ?? { data: null, ok: false, statusCode: null, responseTimeMs: 0, error: "unknown", host: domain };
}

// =============================================================================
// upsertWpSiteByDomain
// =============================================================================

export async function upsertWpSiteByDomain(domain: string) {
  const wpSites = adminDb.collection("wpSites");
  const existing = await wpSites.where("domain", "==", domain).limit(1).get();

  // Alle checks parallel uitvoeren voor snelheid
  const [reachability, wp, ssl] = await Promise.all([
    checkSiteReachability(domain),
    fetchWpSiteData(domain),
    checkSsl(domain),
  ]);

  const payload: Record<string, unknown> = {
    domain,
    lastChecked: FieldValue.serverTimestamp(),
    ok: reachability.ok,
    status: reachability.ok ? "online" : "offline",
    reachability,
    ssl,
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