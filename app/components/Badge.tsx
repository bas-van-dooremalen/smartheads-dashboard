"use client";

import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  color: "red" | "custom" | "yellow";
}

export default function Badge({ children, color }: BadgeProps) {
  const styles: Record<string, string> = {
    red: "bg-red-500/10 text-red-400 border border-red-500/20",
    yellow: "bg-yellow-500/10 text-yellow-400 border border-yellow-500/20",
    custom: "bg-[#20d67b]/10 text-[#20d67b] border border-[#20d67b]/20 shadow-[0_0_15px_rgba(32,214,123,0.1)]",
  };
  return (
    <span className={`px-2.5 py-0.5 text-[10px] uppercase tracking-wider rounded-full font-bold ${styles[color]}`}>
      {children}
    </span>
  );
}
