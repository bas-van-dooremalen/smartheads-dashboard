import { NextResponse } from "next/server";
import * as cheerio from "cheerio";

export async function GET() {
  const res = await fetch("https://omdenken.nl/persoonlijk/inspiratie/quotes/");
  const html = await res.text();
  const $ = cheerio.load(html);

  const quote = $("h3.custom-omdenker-share-title").first().text().trim();

  return NextResponse.json({ quote });
}
