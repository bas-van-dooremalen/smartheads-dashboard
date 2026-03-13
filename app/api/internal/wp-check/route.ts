import { NextResponse } from "next/server";
import pLimit from "p-limit";
import { adminDb } from "../../../lib/firebaseAdmin";
import { normalizeDomain, upsertWpSiteByDomain } from "../../../lib/server/wpDashboardRefresh";

const limit = pLimit(5);

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");

  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const snapshot = await adminDb.collection("wpSites").get();

  await Promise.all(
    snapshot.docs.map((doc) =>
      limit(async () => {
        const domain = normalizeDomain(doc.get("domain"));
        if (!domain) return;
        await upsertWpSiteByDomain(domain);
      })
    )
  );

  return NextResponse.json({ success: true, refreshed: snapshot.size });
}
