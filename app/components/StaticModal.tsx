"use client";

import React from "react";

interface StaticModalProps {
  title: string;
  items: any[];
  onClose: () => void;
}

export default function StaticModal({ title, items, onClose }: StaticModalProps) {
  return (
    <>
      {/* Overlay om de focus op de modal te leggen */}
      <div
        className="fixed inset-0 z-[19000] bg-black/60 backdrop-blur-sm animate-in fade-in duration-300"
        onClick={onClose}
      />

      {/* Modal Container */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[90%] max-w-[360px] bg-neutral-950 border border-white/10 rounded-[2.5rem] shadow-[0_0_100px_rgba(0,0,0,1)] z-[20000] p-8 backdrop-blur-3xl animate-in zoom-in-95 duration-200"
      >
        <div className="flex justify-between items-center mb-6 border-b border-white/5 pb-4">
          <div className="flex flex-col">
            <span className="text-[10px] font-black text-[#20d67b] uppercase tracking-[0.2em]">{title}</span>
            <span className="text-[8px] text-neutral-600 font-mono uppercase italic">Update Registry</span>
          </div>
          <button
            onClick={onClose}
            className="text-[9px] text-white/40 hover:text-white px-3 py-1.5 border border-white/10 rounded-xl font-mono transition-all hover:bg-white/5 active:scale-90"
          >
            ESC
          </button>
        </div>

        <div className="space-y-3 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
          {items.map((item: any, idx: number) => (
            <div key={idx} className="flex flex-col p-4 rounded-2xl bg-white/[0.03] border border-white/5 hover:border-[#20d67b]/20 transition-all">
              <span className="text-[11px] text-white font-bold mb-1.5 leading-tight">{item.name}</span>
              <div className="flex items-center gap-3 font-mono text-[10px]">
                <span className="text-neutral-500">{item.current}</span>
                <span className="text-[#20d67b] opacity-30">→</span>
                <span className="text-[#20d67b] font-bold bg-[#20d67b]/10 px-2 py-0.5 rounded-md">{item.latest}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}