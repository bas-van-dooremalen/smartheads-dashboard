"use client";

import { useEffect, useRef } from "react";

interface AnalogClockProps {
  size?: number;
}

export default function AnalogClock({ size = 120 }: AnalogClockProps) {
  const hourRef = useRef<SVGLineElement>(null);
  const minuteRef = useRef<SVGLineElement>(null);
  const secondRef = useRef<SVGLineElement>(null);

  useEffect(() => {
    function update() {
      const now = new Date();
      const h = now.getHours() % 12;
      const m = now.getMinutes();
      const s = now.getSeconds();
      if (hourRef.current) hourRef.current.style.transform = `rotate(${(360/12)*h + (360/12)*(m/60)}deg)`;
      if (minuteRef.current) minuteRef.current.style.transform = `rotate(${(360/60)*m}deg)`;
      if (secondRef.current) secondRef.current.style.transform = `rotate(${(360/60)*s}deg)`;
    }
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  const r = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={r} cy={r} r={r-2} className="stroke-white/5 fill-neutral-950/20" strokeWidth="1" />
      <line ref={hourRef} x1={r} y1={r} x2={r} y2={r-r*0.4} className="stroke-white" strokeWidth="3" strokeLinecap="round" style={{ transformOrigin: `${r}px ${r}px` }} />
      <line ref={minuteRef} x1={r} y1={r} x2={r} y2={r-r*0.65} className="stroke-neutral-400" strokeWidth="2" strokeLinecap="round" style={{ transformOrigin: `${r}px ${r}px` }} />
      <line ref={secondRef} x1={r} y1={r} x2={r} y2={r-r*0.8} stroke="#20d67b" strokeWidth="1" strokeLinecap="round" style={{ transformOrigin: `${r}px ${r}px` }} />
      <circle cx={r} cy={r} r="3" fill="#20d67b" />
    </svg>
  );
}