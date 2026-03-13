import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "../../../lib/firebaseAdmin";
import { normalizeDomain, upsertWpSiteByDomain } from "../../../lib/server/wpDashboardRefresh";

export const runtime = "nodejs";

const RefreshRequestSchema = z
  .union([
    z.object({ refreshAll: z.literal(true) }).passthrough(),
    z.object({ domain: z.string() }).passthrough(),
  ]);

function isAuthorized(req: Request) {
  // Local dev convenience: don't block UI refresh locally.
  if (process.env.NODE_ENV !== "production") return true;
  const secret = process.env.DASHBOARD_ADMIN_KEY;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${secret}`;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsedReq = RefreshRequestSchema.safeParse(body);
  if (!parsedReq.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if ("refreshAll" in parsedReq.data && parsedReq.data.refreshAll === true) {
    const snapshot = await adminDb.collection("wpSites").get();
    const domains = snapshot.docs
      .map((d) => d.data()?.domain)
      .filter((v): v is string => typeof v === "string");

    // Keep it simple: sequential updates to avoid hammering your WP sites.
    const results: Array<{ domain: string; created: boolean; ok: boolean }> = [];
    for (const domain of domains) {
      const normalized = normalizeDomain(domain);
      if (!normalized) continue;
      results.push(await upsertWpSiteByDomain(normalized));
    }

    return NextResponse.json({
      success: true,
      refreshed: results.length,
      ok: results.filter((r) => r.ok).length,
    });
  }

  const domain = normalizeDomain(parsedReq.data.domain);
  if (!domain) {
    return NextResponse.json({ error: "Invalid domain" }, { status: 400 });
  }

  try {
    const result = await upsertWpSiteByDomain(domain);
    return NextResponse.json({ success: true, ...result });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Server error";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
