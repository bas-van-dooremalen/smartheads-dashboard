import { NextResponse } from "next/server";
import { adminDb }  from "../../lib/firebaseAdmin";

export async function GET() {
  const snapshot = await adminDb.collection("wpSites").get();
  return NextResponse.json({
    count: snapshot.size,
  });
}
