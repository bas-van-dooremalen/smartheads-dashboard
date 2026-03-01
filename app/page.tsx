"use client";

import { useEffect, useState } from "react";

export default function Home() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("Timer staat uit");

  useEffect(() => {
    const speak = (text: string) => {
      const utter = new SpeechSynthesisUtterance(text);
      speechSynthesis.speak(utter);
    };

    const checkTime = () => {
      const now = new Date();
      const h = now.getHours();
      const m = now.getMinutes();
      const s = now.getSeconds();

      setStatus(`Tijd nu: ${now.toLocaleTimeString()}`);

      if (!enabled) return;

      // Spreek om 09:00 en 10:00 (eerste 10 seconden)
      if ((h === 9 || h === 10) && m === 0 && s < 10) {
        speak("Koffie tijd!");
      }
    };

    const interval = setInterval(checkTime, 1000);
    return () => clearInterval(interval);
  }, [enabled]);

  const testSpeak = () => {
    const utter = new SpeechSynthesisUtterance("Test: Koffie tijd!");
    speechSynthesis.speak(utter);
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-900 text-white">
      <div className="p-8 rounded-xl bg-slate-800 border border-slate-700 shadow-xl max-w-lg w-full">
        <h1 className="text-3xl font-bold mb-4 text-amber-300">☕ Koffie Tijd</h1>

        <p className="mb-4">
          Deze app zegt <span className="font-semibold">“Koffie tijd!”</span> om
          <span className="font-mono"> 09:00</span> en
          <span className="font-mono"> 10:00</span>.
        </p>

        <div className="mb-4 p-3 rounded bg-slate-900 text-sm font-mono">
          {status}
        </div>

        <div className="flex flex-col gap-3">
          <button
            onClick={() => setEnabled((v) => !v)}
            className={`px-4 py-2 rounded font-semibold transition ${
              enabled
                ? "bg-green-500 hover:bg-green-600 text-black"
                : "bg-slate-600 hover:bg-slate-500"
            }`}
          >
            {enabled ? "Timer actief (klik om te stoppen)" : "Timer starten"}
          </button>

          <button
            onClick={testSpeak}
            className="px-4 py-2 rounded font-semibold bg-amber-400 hover:bg-amber-500 text-black"
          >
            Test: zeg nu “Koffie tijd!”
          </button>
        </div>

        <p className="mt-4 text-xs text-slate-400">
          Tip: browsers blokkeren audio totdat je één keer klikt. Gebruik de testknop.
        </p>
      </div>
    </main>
  );
}
