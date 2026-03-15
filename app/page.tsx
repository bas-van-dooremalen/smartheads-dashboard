"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { motion } from "framer-motion";

import CustomCursor from "./components/CustomCursor";
import Card from "./components/Card";
import CoffeeWidget from "./components/CoffeeWidget";
import SmartWpWidget from "./components/SmartWpWidget";
import WeatherWidget from "./components/WeatherWidget";


// Compact weather component for header
function HeaderWeather() {
  const [weather, setWeather] = useState<{temp: number; desc: number} | null>(null);

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        const res = await fetch("/api/weather?lat=51.589&lon=4.774");
        const data = await res.json();
        setWeather({ temp: data.temp, desc: data.desc });
      } catch (error) {
        console.error("Weather fetch failed:", error);
      }
    };

    fetchWeather();
    const interval = setInterval(fetchWeather, 30 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (!weather) return null;

  const weatherIcons: Record<number, string> = {
    0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️",
    51: "🌦️", 53: "🌦️", 55: "🌦️", 56: "🌨️", 57: "🌨️",
    61: "🌧️", 63: "🌧️", 65: "🌧️", 66: "🌨️", 67: "🌨️",
    71: "❄️", 73: "❄️", 75: "❄️", 77: "❄️", 80: "🌧️",
    81: "🌧️", 82: "🌧️", 85: "❄️", 86: "❄️", 95: "⛈️",
    96: "⛈️", 99: "⛈️"
  };

  return (
    <div className="flex items-center gap-2 text-neutral-400">
      <span className="text-lg">{weatherIcons[weather.desc] || "🌤️"}</span>
      <span className="text-sm font-mono font-bold">{Math.round(weather.temp)}°</span>
    </div>
  );
}

export default function Home() {
  const containerVariants = {
    hidden: {},
    visible: { transition: { staggerChildren: 0.1 } }
  };

  const rowVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5 } }
  };

  const [now, setNow] = useState(new Date());
  const [mounted, setMounted] = useState(false);
  const [location] = useState("Breda, NL // 51.589° N");

  useEffect(() => {
    setMounted(true);
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!mounted) return null;

  return (
    <motion.main
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="min-h-screen bg-[#050505] text-neutral-200 selection:bg-[#20d67b] selection:text-black relative overflow-x-hidden"
    >
      <CustomCursor />

      <div className="relative w-full px-4 py-8 lg:px-8">

        {/* ── Header ───────────────────────────────────────────────────────── */}
        <header className="flex flex-col md:flex-row justify-between items-center gap-8 mb-6 border-b border-white/5 pb-8">

          {/* Left: logo + naam + coffee subtiel */}
          <div className="flex items-center gap-6">
            {/* Logo */}
            <div className="relative group w-12 h-12 shrink-0">
              <Image
                src="https://cdn.prod.website-files.com/680a90e15faad706ecc85453/68148d1d95733247aa45f248_Logo_Pink.svg"
                alt="Smart.OS Logo" fill className="object-contain animate-[logo-breath_4s_infinite_ease-in-out]" priority
              />
              <div className="absolute inset-0 bg-pink-500/10 blur-xl rounded-full -z-10" />
            </div>

            {/* Naam + tagline + coffee inline */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-black text-white italic tracking-tighter uppercase">Smartheads.OS</h1>
                {/* CoffeeWidget subtiel naast de naam */}
                <div className="opacity-70 hover:opacity-100 transition-opacity">
                  <CoffeeWidget compact />
                </div>
              </div>
              <p className="text-[10px] text-[#20d67b] font-bold uppercase tracking-[0.4em]">System Active</p>
            </div>
          </div>

          {/* Right: weather + week + tijd */}
          <div className="text-right font-mono flex items-center gap-6">
            <HeaderWeather />
            <div className="flex flex-col items-end text-right space-y-1">
              <div className="text-4xl font-black text-white tracking-tighter italic">
                {(() => {
                  const target = new Date(now.valueOf());
                  const dayNr = (now.getDay() + 6) % 7;
                  target.setDate(target.getDate() - dayNr + 3);
                  const firstThursday = target.valueOf();
                  target.setMonth(0, 1);
                  if (target.getDay() !== 4) target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
                  return `W${1 + Math.ceil((firstThursday - target.valueOf()) / 604800000)}`;
                })()}
              </div>
              <div className="text-[10px] text-neutral-600 font-bold uppercase tracking-widest mt-1 italic">
                {now.toLocaleDateString("nl-NL", { weekday: 'short', day: 'numeric', month: 'short' })}
              </div>
            </div>
            <div>
              <div className="text-4xl font-black text-white tracking-tighter italic">
                {now.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </div>
              <div className="text-[10px] text-neutral-600 font-bold uppercase tracking-widest mt-1 italic">{location}</div>
            </div>
          </div>
        </header>

        {/* Widgets Grid */}
        <motion.div variants={rowVariants} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <SmartWpWidget />
        </motion.div>

        {/* Footer */}
        <footer className="mt-16 pt-6 border-t border-white/5 flex justify-between text-neutral-700 text-[9px] font-black uppercase tracking-[0.3em]">
          <span>© 2026 Smart Dashboard Logic</span>
          <span className="text-[#20d67b] animate-pulse">Sync Status: Stable</span>
        </footer>
      </div>

      <style jsx global>{`
        * { cursor: none !important; }
        body { background-color: #050505; overflow-x: hidden; }
        .animate-shake { animation: shake 0.4s cubic-bezier(.36,.07,.19,.97) both; }
        @keyframes shake {
          10%, 90% { transform: translate3d(-1px, 0, 0); }
          20%, 80% { transform: translate3d(2px, 0, 0); }
          30%, 50%, 70% { transform: translate3d(-4px, 0, 0); }
          40%, 60% { transform: translate3d(4px, 0, 0); }
        }
        @keyframes logo-breath {
          0%, 100% { transform: scale(1); filter: brightness(1); }
          50% { transform: scale(1.08); filter: brightness(1.2) drop-shadow(0 0 15px rgba(236, 72, 153, 0.4)); }
        }
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #20d67b33; border-radius: 10px; }
      `}</style>
    </motion.main>
  );
}