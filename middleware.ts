import { NextRequest, NextResponse } from "next/server";

// =============================================================================
// IP Allowlist
//
// Voeg extra IPs toe via de ALLOWED_IPS omgevingsvariabele in Vercel:
// Settings → Environment Variables → ALLOWED_IPS=84.84.24.234,77.60.226.119
//
// De hardcoded lijst hieronder is de fallback voor lokale ontwikkeling.
// =============================================================================

const HARDCODED_IPS = [
  "84.84.24.234",  // Kantoor
  "77.60.226.119", // Kantoor 2
  "::1",           // localhost IPv6
  "127.0.0.1",     // localhost IPv4
];

function getAllowedIps(): Set<string> {
  const envIps = (process.env.ALLOWED_IPS ?? "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  return new Set([...HARDCODED_IPS, ...envIps]);
}

export function middleware(req: NextRequest) {
  // Interne Next.js routes altijd doorlaten
  const { pathname } = req.nextUrl;
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "";

  if (!getAllowedIps().has(ip)) {
    return new NextResponse(
      `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Toegang geweigerd</title>
  <style>
    body { background: #050505; color: #444; font-family: monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .box { text-align: center; }
    h1 { color: #fff; font-size: 1.2rem; letter-spacing: 0.3em; text-transform: uppercase; margin-bottom: 0.5rem; }
    p { font-size: 0.7rem; letter-spacing: 0.2em; text-transform: uppercase; color: #333; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Toegang geweigerd</h1>
    <p>Dit dashboard is alleen toegankelijk vanaf het kantoornetwerk.</p>
  </div>
</body>
</html>`,
      {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};