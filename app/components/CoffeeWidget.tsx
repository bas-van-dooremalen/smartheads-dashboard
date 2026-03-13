"use client";

import { useEffect, useState } from "react";
import Card from "./Card";
import Badge from "./Badge";
import AnalogClock from "./AnalogClock";

interface CoffeeWidgetProps {
  compact?: boolean;
}

export default function CoffeeWidget({ compact = false }: CoffeeWidgetProps) {
  const coffeeTimes = [
    { h: 8, m: 45 },
    { h: 9, m: 45 },
    { h: 10, m: 45 },
    { h: 11, m: 30 }
  ];

  const [now, setNow] = useState<Date>(new Date());
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [lastPlayed, setLastPlayed] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  /* klok */
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  /* laad stem */
  useEffect(() => {
    function loadVoices() {
      const voices = speechSynthesis.getVoices();
      if (!voices.length) return;
      const female =
        voices.find(v => v.name.includes("Zira")) ||
        voices.find(v => v.name.includes("Victoria")) ||
        voices.find(v => v.name.includes("Google") && v.lang.startsWith("nl") && v.name.toLowerCase().includes("female")) ||
        voices.find(v => v.lang.startsWith("nl") && v.name.toLowerCase().includes("female")) ||
        voices.find(v => v.name.toLowerCase().includes("female")) ||
        voices[0];
      setVoice(female);
    }
    loadVoices();
    speechSynthesis.onvoiceschanged = loadVoices;
  }, []);

  /* koffielied */
  function singCoffeeSong() {
    if (!voice) return;
    setIsPlaying(true);
    for (let i = 0; i < 3; i++) {
      const utter = new SpeechSynthesisUtterance("Koffie tijd");
      utter.voice = voice;
      utter.pitch = 1.0;
      utter.rate = 1.0;
      utter.volume = 1;
      setTimeout(() => {
        speechSynthesis.speak(utter);
        if (i === 2) setTimeout(() => setIsPlaying(false), 2000);
      }, i * 1500);
    }
  }

  const consumed = coffeeTimes.filter(
    t => now.getHours() > t.h || (now.getHours() === t.h && now.getMinutes() >= t.m)
  ).length;

  const nextCoffee = coffeeTimes.find(
    t => now.getHours() < t.h || (now.getHours() === t.h && now.getMinutes() < t.m)
  );

  const nextDate = new Date(now);
  if (nextCoffee) {
    nextDate.setHours(nextCoffee.h, nextCoffee.m, 0, 0);
  } else {
    const first = coffeeTimes[0];
    nextDate.setDate(nextDate.getDate() + 1);
    nextDate.setHours(first.h, first.m, 0, 0);
  }

  const diff = nextDate.getTime() - now.getTime();
  const nextTime = nextDate.getTime();

  /* trigger lied */
  useEffect(() => {
    if (!voice) return;
    if (diff <= 5000 && diff >= 0) {
      setLastPlayed((prev) => {
        if (prev !== nextTime) {
          singCoffeeSong();
          return nextTime;
        }
        return prev;
      });
    }
  }, [diff, voice, nextTime]);

  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  const countdown = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  // ─── Compact modus: één regel voor in de header ───────────────────────────
  if (compact) {
    return (
      <div
        className={`flex items-center gap-2.5 px-3 py-1.5 rounded-2xl border transition-all duration-500 ${
          isPlaying
            ? "border-[#20d67b]/40 bg-[#20d67b]/10 shadow-[0_0_12px_rgba(32,214,123,0.2)]"
            : "border-white/5 bg-white/[0.03]"
        }`}
      >
        {/* Koffie dots */}
        <div className="flex items-center gap-1">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-full transition-all duration-700 ${
                i < consumed
                  ? "bg-[#20d67b] shadow-[0_0_4px_#20d67b]"
                  : "bg-white/10"
              }`}
            />
          ))}
        </div>

        {/* Scheidingslijn */}
        <div className="w-px h-3 bg-white/10" />

        {/* Emoji + countdown */}
        <span className="text-sm leading-none">{isPlaying ? "☕" : "☕"}</span>
        <span className={`text-[11px] font-mono font-bold tracking-widest ${isPlaying ? "text-[#20d67b]" : "text-neutral-500"}`}>
          {isPlaying ? "Koffietijd!" : countdown}
        </span>
      </div>
    );
  }

  // ─── Volledige widget ─────────────────────────────────────────────────────
  return (
    <Card className={`h-full flex flex-col justify-between transition-all duration-500 ${
      isPlaying ? "shadow-[0_0_20px_#20d67b] bg-gradient-to-br from-[#20d67b]/10 to-transparent" : ""
    }`}>
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-black text-white italic uppercase tracking-tighter">
          {isPlaying ? "Koffietijd!" : "Koffie"}
        </h2>
        <Badge color={consumed < 4 ? "custom" : "red"}>
          {consumed}/4
        </Badge>
      </div>

      <div className="flex flex-col items-center gap-6">
        <AnalogClock />

        <div className="flex gap-2 w-full">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full transition-all duration-1000 ${
                i < consumed
                  ? "bg-[#20d67b] shadow-[0_0_8px_#20d67b]"
                  : "bg-white/5"
              }`}
            />
          ))}
        </div>

        <div className="text-center">
          <p className="text-[9px] text-neutral-600 uppercase tracking-widest font-mono">Next Coffee</p>
          <p className="text-sm font-mono text-[#20d67b] tracking-widest mt-1">{countdown}</p>

          <div className="mt-4 flex justify-center gap-2">
            {coffeeTimes.map((time, i) => (
              <div
                key={i}
                className={`px-2 py-1 rounded-full text-xs font-mono border ${
                  i < consumed
                    ? "bg-[#20d67b]/20 border-[#20d67b] text-[#20d67b]"
                    : "bg-neutral-800/50 border-neutral-600 text-neutral-400"
                }`}
              >
                {String(time.h).padStart(2, "0")}:{String(time.m).padStart(2, "0")}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}