"use client";

import React from "react";
import { motion } from "framer-motion";

interface CardProps {
  children: React.ReactNode;
  className?: string;
}

export default function Card({ children, className = "" }: CardProps) {
  return (
    <motion.div
      variants={{
        hidden: { opacity: 0, y: 20 },
        visible: { opacity: 1, y: 0 }
      }}
      initial="hidden"
      animate="visible"
      className={`bg-neutral-900/40 backdrop-blur-xl border border-white/5 rounded-3xl p-8 transition-all duration-500 hover:border-[#20d67b]/20 shadow-2xl relative group ${className}`}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-[#20d67b]/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none" />
      {children}
    </motion.div>
  );
}