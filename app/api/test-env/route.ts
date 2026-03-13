import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ? "aanwezig" : "ontbreekt",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ? "aanwezig" : "ontbreekt",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ? "aanwezig" : "ontbreekt",
  });
}
