"use client";

import { useEffect, useState } from "react";
import Card from "./Card";

interface WeatherData {
  temp: number;
  wind: number;
  desc: number;
}

const weatherIcons: Record<number, string> = {
  0: "☀️",
  1: "🌤️",
  2: "⛅",
  3: "☁️",
  45: "🌫️",
  48: "🌫️",
  51: "🌦️",
  53: "🌦️",
  55: "🌦️",
  56: "🌨️",
  57: "🌨️",
  61: "🌧️",
  63: "🌧️",
  65: "🌧️",
  66: "🌨️",
  67: "🌨️",
  71: "❄️",
  73: "❄️",
  75: "❄️",
  77: "❄️",
  80: "🌧️",
  81: "🌧️",
  82: "🌧️",
  85: "❄️",
  86: "❄️",
  95: "⛈️",
  96: "⛈️",
  99: "⛈️",
};

// Breda
const LAT = 51.589;
const LON = 4.774;

export default function WeatherWidget() {
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        const url =
          `https://api.open-meteo.com/v1/forecast` +
          `?latitude=${LAT}&longitude=${LON}` +
          `&current=temperature_2m,wind_speed_10m,weather_code` +
          `&wind_speed_unit=kmh`;

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        setWeather({
          temp: data.current.temperature_2m,
          wind: data.current.wind_speed_10m,
          desc: data.current.weather_code,
        });
      } catch (error) {
        console.error("Weather fetch failed:", error);
        setWeather(null);
      } finally {
        setLoading(false);
      }
    };

    fetchWeather();
    const interval = setInterval(fetchWeather, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <Card className="flex flex-col justify-center items-center">
        <div className="animate-pulse">
          <div className="text-4xl mb-2">🌤️</div>
          <div className="text-[10px] text-neutral-600 uppercase tracking-widest font-mono">Loading...</div>
        </div>
      </Card>
    );
  }

  if (!weather) {
    return (
      <Card className="flex flex-col justify-center items-center">
        <div className="text-4xl mb-2">❓</div>
        <div className="text-[10px] text-neutral-600 uppercase tracking-widest font-mono">Weather unavailable</div>
      </Card>
    );
  }

  return (
    <Card className="flex flex-col justify-center items-center relative group">
      <div className="text-5xl mb-4 transition-transform group-hover:scale-110 duration-300">
        {weatherIcons[weather.desc] ?? "🌤️"}
      </div>
      <div className="text-center">
        <div className="text-2xl font-black text-white italic tracking-tighter">
          {Math.round(weather.temp)}°C
        </div>
        <div className="text-[10px] text-neutral-600 uppercase tracking-widest font-mono mt-1">
          {Math.round(weather.wind)} km/h wind
        </div>
      </div>
    </Card>
  );
}