import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");

  if (!lat || !lon) {
    return NextResponse.json({ error: "Geen locatie ontvangen." });
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    const data = await res.json();

    const c = data.current_weather;

    return NextResponse.json({
      temp: c.temperature,
      wind: c.windspeed,
      desc: c.weathercode,
      summary: c.weathercode,
    });
  } catch (e) {
    return NextResponse.json({ error: "Kon weerdata niet laden." });
  }
}
