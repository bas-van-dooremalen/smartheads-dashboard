import { NextResponse } from "next/server";
import { z } from "zod";
import { adminDb } from "../../lib/firebaseAdmin";

export const runtime = "nodejs";

const ReviewRequestSchema = z.object({
  siteId: z.string().min(1).max(200),
  review: z.object({
    checked: z.boolean(),
    formSubmitted: z.boolean(),
    confirmationReceived: z.boolean(),
    updatedAt: z.number().int().nonnegative(),
  }).strict(),
}).strict();

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

  const parsed = ReviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const siteRef = adminDb.collection("wpSites").doc(parsed.data.siteId);
    const site = await siteRef.get();
    if (!site.exists) return NextResponse.json({ error: "Site not found" }, { status: 404 });
    await siteRef.update({ manualReview: parsed.data.review });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Could not save review" }, { status: 500 });
  }
}
