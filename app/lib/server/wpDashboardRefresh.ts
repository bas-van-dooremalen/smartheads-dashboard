import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { adminDb } from "../firebaseAdmin";

const FETCH_TIMEOUT_MS = 60_000;

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

export async function fetchWpSiteData(domain: string) {
  const apiKey = process.env.WP_DASHBOARD_API_KEY;
  if (!apiKey) throw new Error("Missing WP_DASHBOARD_API_KEY");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://${domain}/wp-json/dashboard/v1/updates?key=${encodeURIComponent(apiKey)}&_=${Date.now()}`,
      { cache: "no-store", signal: controller.signal }
    );
    if (!res.ok) return null;
    const json = await res.json();
    const parsed = WpSiteDataSchema.safeParse(json);
    if (!parsed.success) return null;
    return parsed.data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function upsertWpSiteByDomain(domain: string) {
  const wpSites = adminDb.collection("wpSites");
  const existing = await wpSites.where("domain", "==", domain).limit(1).get();
  const data = await fetchWpSiteData(domain);

  const payload = data
    ? {
        domain,
        lastChecked: FieldValue.serverTimestamp(),
        lastData: data,
        ok: true,
        status: "online",
      }
    : {
        domain,
        lastChecked: FieldValue.serverTimestamp(),
        ok: false,
        status: "offline",
      };

  if (existing.empty) {
    await wpSites.add(payload);
    return { domain, created: true, ok: !!data };
  }

  await existing.docs[0]!.ref.set(payload, { merge: true });
  return { domain, created: false, ok: !!data };
}

