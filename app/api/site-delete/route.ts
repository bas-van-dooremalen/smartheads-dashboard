import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "../../lib/firebaseAdmin";

export const runtime = "nodejs";

const DeleteRequestSchema = z.object({ siteId: z.string().min(1).max(200) }).strict();

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  if (!origin || origin !== new URL(req.url).origin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = DeleteRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const siteRef = adminDb.collection("wpSites").doc(parsed.data.siteId);
    const site = await siteRef.get();
    if (!site.exists) return NextResponse.json({ error: "Site not found" }, { status: 404 });
    await siteRef.delete();
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Could not delete site" }, { status: 500 });
  }
}
