import { NextRequest, NextResponse } from "next/server";
import { Agent } from "undici";

const API_KEY = "f9e1c4b7a3d8f0c2e6b1a9d4f7c3e8a1b6d9f2c4e7a0b3d5f8c1e4a7b2d9f3c6e1a4b7d0f2c9e5a1d4b8f0c3e6a9d2f5b1c7e4a0f8d3";

export const runtime = "nodejs";
export const maxDuration = 120; // Vercel: max 120s voor deze route

const wpInsecureTls = process.env.WP_FETCH_INSECURE_TLS === "1";
const wpFetchDispatcher = wpInsecureTls
  ? new Agent({ connect: { rejectUnauthorized: false } })
  : undefined;

export async function GET(req: NextRequest) {
  const domain = req.nextUrl.searchParams.get("domain");

  if (!domain) {
    return NextResponse.json({ error: "Missing domain" }, { status: 400 });
  }

  const url = `https://${domain}/wp-json/dashboard/v1/updates?key=${API_KEY}`;

  try {
    const res = await fetch(url, ({
      // Server-side fetch heeft geen browser timeout limiet
      // Next.js gebruikt Node.js fetch die standaard geen timeout heeft
      next: { revalidate: 0 }, // geen caching
      dispatcher: wpFetchDispatcher,
    } as unknown as RequestInit));

    if (!res.ok) {
      return NextResponse.json({ error: `HTTP ${res.status}` }, { status: res.status });
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Fetch failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
