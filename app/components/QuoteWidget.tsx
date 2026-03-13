"use client";

import { useEffect, useState } from "react";
import Card from "./Card";

interface QuoteData {
  quote: string;
}

export default function QuoteWidget() {
  const [quote, setQuote] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchQuote = async () => {
      try {
        const res = await fetch("/api/quote");
        const data: QuoteData = await res.json();
        setQuote(data.quote);
      } catch (error) {
        console.error("Quote fetch failed:", error);
        setQuote("Het leven is wat je ervan maakt.");
      } finally {
        setLoading(false);
      }
    };

    fetchQuote();
    const interval = setInterval(fetchQuote, 60 * 60 * 1000); // every hour
    return () => clearInterval(interval);
  }, []);

  return (
    <Card className="h-full flex flex-col justify-center items-center text-center relative group">
      <div className="relative z-10">
        <p className="text-neutral-500 text-[10px] uppercase tracking-[0.5em] mb-4 font-bold italic">Daily Wisdom</p>
        <div className="flex items-start justify-center gap-2">
          <span className="text-4xl text-[#20d67b] opacity-60 italic">"</span>
          <p className="text-4xl font-black text-white tracking-tighter italic uppercase transition-all group-hover:tracking-normal duration-700 leading-tight lg:max-w-6xl">
            {loading ? "..." : quote}
          </p>
        </div>
      </div>
    </Card>
  );
}