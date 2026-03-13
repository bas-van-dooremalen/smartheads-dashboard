"use client";

import { useEffect, useRef } from "react";

export default function CustomCursor() {
  const cursorRef = useRef<HTMLDivElement>(null);
  const followerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const moveCursor = (e: MouseEvent) => {
      if (cursorRef.current && followerRef.current) {
        cursorRef.current.style.transform = `translate3d(${e.clientX}px, ${e.clientY}px, 0)`;
        followerRef.current.animate({
          transform: `translate3d(${e.clientX}px, ${e.clientY}px, 0)`
        }, { duration: 400, fill: "forwards" });
      }
    };
    window.addEventListener("mousemove", moveCursor);
    return () => window.removeEventListener("mousemove", moveCursor);
  }, []);

  return (
    <>
      <div
        ref={cursorRef}
        className="fixed top-0 left-0 w-3 h-3 rounded-full bg-[#20d67b] pointer-events-none z-[100000] mix-blend-difference shadow-[0_0_10px_#20d67b]"
        style={{ left: '-6px', top: '-10px' }}
      />
      <div
        ref={followerRef}
        className="fixed top-0 left-0 w-10 h-10 bg-[#20d67b]/10 rounded-full blur-xl pointer-events-none z-[99999]"
        style={{ left: '-20px', top: '-20px' }}
      />
    </>
  );
}