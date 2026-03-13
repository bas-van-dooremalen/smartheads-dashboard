"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/app/lib/firebaseClient";
import {
  deleteSiteFromFirebase,
} from "@/app/lib/wpSites";
import { collection, onSnapshot } from "firebase/firestore";
import Card from "./Card";
import Badge from "./Badge";
import StaticModal from "./StaticModal";
import { useAlertLog, AlertLogPanel, syncAlertsToLog } from "./AlertLog";

// ─── Config ────────────────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const PAGE_SIZE           = 7;
const SLIDE_INTERVAL_MS   = 8_500;
const SSL_WARN_DAYS       = 30;

// ─── Types ─────────────────────────────────────────────────────────────────────

interface HttpCheck {
  url: string;
  post_id: number | null;
  status_code: number;
  status_text: string;
  response_time_ms: number;
  ok: boolean;
  is_redirect: boolean;
  is_error: boolean;
}

interface HttpHealth {
  has_errors: boolean;
  error_count: number;
  total_checked: number;
  checks: HttpCheck[];
}

interface OfflineEvent {
  url: string;
  timestamp: number;
  date: string;
  status_code: number;
  reason: string;
}

interface OfflineLog {
  total_events: number;
  events: OfflineEvent[];
}

interface Ssl {
  valid: boolean;
  days_remaining: number | null;
  expiry_date: string | null;
  status: "ok" | "critical" | "error";
  message: string;
}

interface WpSiteData {
  site?: string;
  php?: string;
  core?: { current: string; needs_update: boolean };
  plugins?: { name: string; needs_update: boolean }[];
  themes?: { name: string; needs_update: boolean }[];
  http_health?: HttpHealth;
  ssl?: Ssl;
  offline_log?: OfflineLog;
}

interface WpSite {
  id: string;
  domain: string;
  ok: boolean;
  status?: string;
  lastData?: WpSiteData;
  reachability?: {
    ok: boolean;
    url: string;
    statusCode: number | null;
    statusText: string | null;
    responseTimeMs: number;
    checkedAt: number;
    error: string | null;
  };
  lastWpFetchOk?: boolean;
  lastWpFetchError?: string | null;
}

type FilterType = "all" | "core" | "plugins" | "themes" | "http" | "ssl";
type LayoutType = "grid" | "list";
type SortType   = "name" | "updates";

interface CriticalAlert {
  siteId: string;
  siteName: string;
  domain: string;
  type: "offline" | "http" | "ssl" | "offline_event";
  label: string;
  detail: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function decodeSiteName(name: string): string {
  if (typeof document === "undefined") return name;
  const txt = document.createElement("textarea");
  txt.innerHTML = name;
  return txt.value;
}

function getSiteName(site: WpSite): string {
  return decodeSiteName(site.lastData?.site ?? site.domain);
}

function isOnline(site: WpSite): boolean {
  return (site.reachability?.ok ?? site.ok) === true;
}

function offlineReason(site: WpSite): string {
  const r = site.reachability;
  if (!r) return "Site reageert niet";
  if (r.error) return r.error;
  if (r.statusCode !== null) return `HTTP ${r.statusCode}`;
  return "Site reageert niet";
}

function getUpdateCount(site: WpSite): number {
  let count = site.lastData?.core?.needs_update ? 1 : 0;
  count += site.lastData?.plugins?.filter((p) => p.needs_update).length ?? 0;
  count += site.lastData?.themes?.filter((t) => t.needs_update).length ?? 0;
  return count;
}

type RefreshResult = "ok" | "unauthorized" | "error";

async function triggerRefreshAll(adminKey: string | null): Promise<RefreshResult> {
  const res = await fetch("/api/internal/wp-refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(adminKey ? { authorization: `Bearer ${adminKey}` } : {}),
    },
    body: JSON.stringify({ refreshAll: true }),
  });
  if (res.status === 401) return "unauthorized";
  return res.ok ? "ok" : "error";
}

async function triggerRefreshDomainWithAuth(
  domain: string,
  adminKey: string | null
): Promise<RefreshResult> {
  const res = await fetch("/api/internal/wp-refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(adminKey ? { authorization: `Bearer ${adminKey}` } : {}),
    },
    body: JSON.stringify({ domain }),
  });
  if (res.status === 401) return "unauthorized";
  return res.ok ? "ok" : "error";
}

function buildCriticalAlerts(sites: WpSite[]): CriticalAlert[] {
  const alerts: CriticalAlert[] = [];

  for (const site of sites) {
    const name   = getSiteName(site);
    const domain = site.domain;

    if (!isOnline(site)) {
      alerts.push({ siteId: site.id, siteName: name, domain, type: "offline", label: "Offline", detail: offlineReason(site) });
    }

    if (!site.lastData) continue;

    if (site.lastData.http_health?.has_errors) {
      const count = site.lastData.http_health.error_count;
      alerts.push({ siteId: site.id, siteName: name, domain, type: "http", label: "HTTP fouten", detail: `${count} pagina${count === 1 ? "" : "s"} met fout` });
    }

    if (site.lastData.ssl) {
      const { status, days_remaining } = site.lastData.ssl;
      if (status === "error") {
        alerts.push({ siteId: site.id, siteName: name, domain, type: "ssl", label: "SSL fout", detail: "Certificaat ongeldig" });
      } else if (status === "critical") {
        alerts.push({ siteId: site.id, siteName: name, domain, type: "ssl", label: "SSL verloopt", detail: `Nog ${days_remaining} dagen` });
      } else if (days_remaining !== null && days_remaining <= SSL_WARN_DAYS) {
        alerts.push({ siteId: site.id, siteName: name, domain, type: "ssl", label: "SSL binnenkort", detail: `Nog ${days_remaining} dagen` });
      }
    }

    if (site.lastData.offline_log && site.lastData.offline_log.total_events > 0) {
      const count = site.lastData.offline_log.total_events;
      const last  = site.lastData.offline_log.events[0];
      alerts.push({ siteId: site.id, siteName: name, domain, type: "offline_event", label: "Offline geweest", detail: last ? last.date : `${count}x` });
    }
  }

  return alerts;
}

// ─── Badge class helpers ───────────────────────────────────────────────────────

const badgeBase    = "inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-black uppercase tracking-wider";
const badgeNeutral = `${badgeBase} bg-white/5 border-white/10 text-neutral-300`;
const badgeRed     = `${badgeBase} bg-red-500/10 border-red-500/20 text-red-400`;
const badgeOrange  = `${badgeBase} bg-orange-500/10 border-orange-500/20 text-orange-400`;

// ─── Alert type config ─────────────────────────────────────────────────────────

const alertConfig: Record<CriticalAlert["type"], { color: string; bg: string; border: string; icon: React.ReactNode }> = {
  offline: {
    color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/20",
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>,
  },
  http: {
    color: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/20",
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  },
  ssl: {
    color: "text-yellow-400", bg: "bg-yellow-500/10", border: "border-yellow-500/20",
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
  },
  offline_event: {
    color: "text-orange-400", bg: "bg-orange-500/10", border: "border-orange-500/20",
    icon: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  },
};

// ─── Sub-components ────────────────────────────────────────────────────────────

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-neutral-500 hover:text-white transition-colors">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}

function ModalShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[30000] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md" onClick={onClose}>
      <div className="bg-neutral-950 border border-white/10 rounded-[2.5rem] max-w-2xl w-full shadow-2xl flex flex-col max-h-[80vh]" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function SslBadge({ ssl }: { ssl: Ssl }) {
  const lockIcon = (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
  if (ssl.status === "ok") {
    return <div className={badgeNeutral}>{lockIcon}<span>SSL {ssl.days_remaining}d</span></div>;
  }
  const label = ssl.status === "error" ? "SSL fout" : ssl.days_remaining !== null && ssl.days_remaining < 0 ? "SSL verlopen" : `SSL ${ssl.days_remaining}d`;
  return <div className={badgeRed}>{lockIcon}<span>{label}</span></div>;
}

function HttpHealthBadge({ health, onClick }: { health: HttpHealth; onClick: () => void }) {
  if (health.has_errors) {
    return (
      <button onClick={onClick} className={`${badgeRed} hover:bg-red-500/20 transition-all`}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span>{health.error_count} HTTP {health.error_count === 1 ? "fout" : "fouten"}</span>
      </button>
    );
  }
  return (
    <button onClick={onClick} className={`${badgeNeutral} hover:border-[#20d67b]/20 hover:text-[#20d67b] transition-all`}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      <span>{health.total_checked} OK</span>
    </button>
  );
}

function HttpHealthModal({ health, siteName, onClose }: { health: HttpHealth; siteName: string; onClose: () => void }) {
  const [tab, setTab] = useState<"errors" | "all">("errors");
  const displayed = tab === "errors" ? health.checks.filter((c) => c.is_error) : health.checks;
  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-start justify-between p-8 pb-4 border-b border-white/5">
        <div>
          <h4 className="text-xl font-black text-white italic uppercase tracking-tighter">{siteName}</h4>
          <p className="text-xs font-mono text-neutral-500 mt-1 uppercase tracking-widest">HTTP Health Monitor</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right"><p className="text-xs font-mono text-neutral-500 uppercase tracking-widest">Checked</p><p className="text-lg font-black text-white">{health.total_checked}</p></div>
          <div className="text-right"><p className="text-xs font-mono text-neutral-500 uppercase tracking-widest">Errors</p><p className={`text-lg font-black ${health.error_count > 0 ? "text-red-400" : "text-[#20d67b]"}`}>{health.error_count}</p></div>
          <div className="ml-4"><CloseButton onClick={onClose} /></div>
        </div>
      </div>
      <div className="flex gap-2 px-8 pt-4">
        <button onClick={() => setTab("errors")} className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-all border ${tab === "errors" ? "bg-red-500/20 text-red-400 border-red-500/30" : "bg-white/5 text-neutral-400 border-white/5 hover:border-white/20"}`}>Errors ({health.error_count})</button>
        <button onClick={() => setTab("all")} className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-all border ${tab === "all" ? "bg-[#20d67b]/20 text-[#20d67b] border-[#20d67b]/30" : "bg-white/5 text-neutral-400 border-white/5 hover:border-white/20"}`}>Alle ({health.total_checked})</button>
      </div>
      <div className="overflow-y-auto flex-1 px-8 py-4 space-y-2">
        {displayed.length === 0 ? <EmptyState label="Geen fouten gevonden" /> : displayed.map((check, i) => (
          <div key={i} className={`flex items-center justify-between gap-4 px-4 py-3 rounded-2xl border transition-all ${check.is_error ? "bg-red-500/5 border-red-500/20" : check.is_redirect ? "bg-yellow-500/5 border-yellow-500/10" : "bg-white/[0.02] border-white/5"}`}>
            <div className="flex items-center gap-3 shrink-0">
              <div className={`w-2 h-2 rounded-full ${check.is_error ? "bg-red-400" : check.is_redirect ? "bg-yellow-400" : "bg-[#20d67b]"}`} />
              <span className={`text-sm font-black font-mono w-10 ${check.is_error ? "text-red-400" : check.is_redirect ? "text-yellow-400" : "text-[#20d67b]"}`}>{check.status_code || "ERR"}</span>
            </div>
            <a href={check.url} target="_blank" rel="noopener noreferrer" className="flex-1 text-xs font-mono text-neutral-400 hover:text-white transition-colors truncate">{check.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</a>
            <span className={`text-xs font-mono shrink-0 ${check.response_time_ms > 800 ? "text-yellow-400" : check.response_time_ms > 400 ? "text-neutral-400" : "text-neutral-600"}`}>{check.response_time_ms}ms</span>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

function OfflineLogModal({ log, siteName, onClose }: { log: OfflineLog; siteName: string; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose}>
      <div className="flex items-start justify-between p-8 pb-4 border-b border-white/5">
        <div>
          <h4 className="text-xl font-black text-white italic uppercase tracking-tighter">{siteName}</h4>
          <p className="text-xs font-mono text-neutral-500 mt-1 uppercase tracking-widest">Offline History</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right"><p className="text-xs font-mono text-neutral-500 uppercase tracking-widest">Events</p><p className={`text-lg font-black ${log.total_events > 0 ? "text-red-400" : "text-[#20d67b]"}`}>{log.total_events}</p></div>
          <div className="ml-4"><CloseButton onClick={onClose} /></div>
        </div>
      </div>
      <div className="overflow-y-auto flex-1 px-8 py-4 space-y-2">
        {log.events.length === 0 ? <EmptyState label="Geen offline events geregistreerd" /> : log.events.map((event, i) => (
          <div key={i} className="flex items-center justify-between gap-4 px-4 py-3 rounded-2xl border bg-red-500/5 border-red-500/20">
            <div className="flex items-center gap-3 shrink-0">
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <span className="text-sm font-black font-mono w-10 text-red-400">{event.status_code || "ERR"}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-mono text-neutral-400 truncate">{event.url.replace(/^https?:\/\/[^/]+/, "") || "/"}</p>
              <p className="text-xs font-mono text-neutral-600 mt-0.5">{event.reason}</p>
            </div>
            <span className="text-xs font-mono text-neutral-600 shrink-0 text-right">{event.date}</span>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="py-12 flex flex-col items-center justify-center">
      <div className="w-10 h-10 rounded-full bg-[#20d67b]/10 flex items-center justify-center mb-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#20d67b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </div>
      <p className="text-neutral-500 text-xs font-black uppercase tracking-widest">{label}</p>
    </div>
  );
}

// ─── Critical Alerts Panel ─────────────────────────────────────────────────────

function CriticalAlertsPanel({ alerts }: { alerts: CriticalAlert[] }) {
  return (
    <div className="flex flex-col bg-neutral-950/60 border border-white/5 rounded-[2rem] p-6 min-w-[280px] w-[280px] shrink-0">
      <div className="flex items-center gap-3 mb-5">
        <div className={`w-2 h-2 rounded-full ${alerts.length > 0 ? "bg-red-400 animate-pulse" : "bg-[#20d67b]"}`} />
        <h3 className="text-xs font-black uppercase tracking-widest text-neutral-300">Kritieke meldingen</h3>
        {alerts.length > 0 && (
          <span className="ml-auto w-5 h-5 rounded-full bg-red-500 text-white text-[9px] font-black flex items-center justify-center">{alerts.length}</span>
        )}
      </div>

      {alerts.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center py-8">
          <div className="w-10 h-10 rounded-full bg-[#20d67b]/10 flex items-center justify-center mb-3">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#20d67b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <p className="text-neutral-600 text-[10px] font-black uppercase tracking-widest text-center">Alles in orde</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2 overflow-y-auto flex-1">
          {alerts.map((alert, i) => {
            const cfg = alertConfig[alert.type];
            return (
              <a
                key={i}
                href={`https://${alert.domain}/wp-admin`}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-start gap-3 px-3 py-3 rounded-2xl border ${cfg.bg} ${cfg.border} hover:opacity-80 transition-all`}
              >
                <span className={`mt-0.5 shrink-0 ${cfg.color}`}>{cfg.icon}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-black text-white truncate">{alert.siteName}</p>
                  <p className={`text-[10px] font-mono ${cfg.color} mt-0.5`}>{alert.label} — {alert.detail}</p>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Table with pagination/slides ─────────────────────────────────────────────

function PaginatedTable({
  sites,
  onHealthModal,
  onOfflineModal,
  onDeleteConfirm,
  expandedSite,
  setExpandedSite,
}: {
  sites: WpSite[];
  onHealthModal: (id: string) => void;
  onOfflineModal: (id: string) => void;
  onDeleteConfirm: (id: string) => void;
  expandedSite: string | null;
  setExpandedSite: (v: string | null) => void;
}) {
  const totalPages = Math.ceil(sites.length / PAGE_SIZE);
  const [page, setPage]     = useState(0);
  const [paused, setPaused] = useState(true);
  const [visible, setVisible] = useState(true);
  const timerRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const pageRef   = useRef(page);

  useEffect(() => {
    pageRef.current = page;
  }, [page]);

  useEffect(() => {
    const t = setTimeout(() => setPage(0), 0);
    return () => clearTimeout(t);
  }, [sites]);

  const fadeTo = useCallback((next: number) => {
    setVisible(false);
    setTimeout(() => {
      setPage(next);
      setVisible(true);
    }, 300);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (totalPages <= 1 || paused) return;
    timerRef.current = setInterval(() => {
      fadeTo((pageRef.current + 1) % totalPages);
    }, SLIDE_INTERVAL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [totalPages, paused, fadeTo]);

  const goTo = (p: number) => {
    if (timerRef.current) clearInterval(timerRef.current);
    fadeTo(p);
    if (!paused && totalPages > 1) {
      timerRef.current = setInterval(() => {
        fadeTo((pageRef.current + 1) % totalPages);
      }, SLIDE_INTERVAL_MS);
    }
  };

  const pageSites = sites.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="flex flex-col flex-1 min-w-0">
      <div
        className="overflow-x-auto transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
      >
        <table className="min-w-full divide-y divide-white/10">
          <thead>
            <tr className="bg-neutral-900">
              {["Site","PHP","Core","Plugins","Themes","HTTP","SSL","Offline","Status",""].map((h) => (
                <th key={h} className={`px-4 py-4 text-xs font-black uppercase tracking-wider text-neutral-400 ${h === "Site" ? "text-left px-6" : ""}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="bg-neutral-950 divide-y divide-white/10">
            {pageSites.map((s) => (
              <tr key={s.id} className="hover:bg-neutral-900/60 transition-colors">

                {/* Site */}
                <td className="px-6 py-5 whitespace-nowrap">
                  <a href={`https://${s.domain}/wp-admin`} target="_blank" rel="noopener noreferrer" className="font-bold text-base text-white hover:text-[#20d67b] transition-colors">{getSiteName(s)}</a>
                  <p className="text-xs font-mono text-neutral-500 mt-0.5">{s.domain}</p>
                </td>

                {/* PHP */}
                <td className="px-4 py-5 text-center">
                  {s.lastData?.php ? (
                    <span className={`${badgeBase} ${s.lastData.php.startsWith("8") ? "bg-white/5 border-white/10 text-neutral-300" : "bg-yellow-500/10 border-yellow-500/20 text-yellow-400"}`}>{s.lastData.php}</span>
                  ) : <span className="text-neutral-600 text-sm font-mono">—</span>}
                </td>

                {/* Core */}
                <td className="px-4 py-5 text-center">
                  {s.lastData?.core?.needs_update ? <Badge color="yellow">!</Badge> : <Badge color="custom">OK</Badge>}
                </td>

                {/* Plugins */}
                <td className="px-4 py-5 text-center text-base font-bold text-white">
                  {s.lastData?.plugins?.filter((p) => p.needs_update).length ?? 0}
                </td>

                {/* Themes */}
                <td className="px-4 py-5 text-center text-base font-bold text-white">
                  {s.lastData?.themes?.filter((t) => t.needs_update).length ?? 0}
                </td>

                {/* HTTP */}
                <td className="px-4 py-5 text-center">
                  {s.lastData?.http_health ? (
                    <button onClick={() => onHealthModal(s.id)} className={`${badgeBase} transition-all ${s.lastData.http_health.has_errors ? "bg-red-500/10 border-red-500/20 text-red-400 hover:bg-red-500/20" : "bg-white/5 border-white/10 text-neutral-300 hover:border-[#20d67b]/20 hover:text-[#20d67b]"}`}>
                      {s.lastData.http_health.has_errors ? (
                        <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>{s.lastData.http_health.error_count} err</>
                      ) : (
                        <><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>{s.lastData.http_health.total_checked} ok</>
                      )}
                    </button>
                  ) : <span className="text-neutral-600 text-sm font-mono">—</span>}
                </td>

                {/* SSL */}
                <td className="px-4 py-5 text-center">
                  {s.lastData?.ssl ? (
                    <span title={s.lastData.ssl.message} className={`${badgeBase} ${s.lastData.ssl.status === "critical" || s.lastData.ssl.status === "error" ? "bg-red-500/10 border-red-500/20 text-red-400" : "bg-white/5 border-white/10 text-neutral-300"}`}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      {s.lastData.ssl.status === "ok" ? `${s.lastData.ssl.days_remaining}d` : s.lastData.ssl.status === "error" ? "err" : `${s.lastData.ssl.days_remaining}d!`}
                    </span>
                  ) : <span className="text-neutral-600 text-sm font-mono">—</span>}
                </td>

                {/* Offline */}
                <td className="px-4 py-5 text-center">
                  {s.lastData?.offline_log ? (
                    <button onClick={() => onOfflineModal(s.id)} className={`${badgeBase} transition-all ${s.lastData.offline_log.total_events > 0 ? "bg-orange-500/10 border-orange-500/20 text-orange-400 hover:bg-orange-500/20" : "bg-white/5 border-white/10 text-neutral-300 hover:border-white/20"}`}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      {s.lastData.offline_log.total_events}
                    </button>
                  ) : <span className="text-neutral-600 text-sm font-mono">—</span>}
                </td>

                {/* Status */}
                <td className="px-4 py-5 text-center">
                  <span title={!isOnline(s) ? offlineReason(s) : undefined}>
                    <Badge color={isOnline(s) ? "custom" : "red"}>{s.status ?? (isOnline(s) ? "online" : "offline")}</Badge>
                  </span>
                </td>

                {/* Acties */}
                <td className="px-4 py-5 text-center">
                  <button onClick={() => onDeleteConfirm(s.id)} aria-label={`Verwijder ${s.domain}`} className="text-neutral-500 hover:text-white transition-colors">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* StaticModal for expanded plugin/theme */}
      {expandedSite && (() => {
        const siteId = expandedSite.replace(/-[pt]$/, "");
        const site   = sites.find((s) => s.id === siteId);
        if (!site?.lastData) return null;
        return (
          <StaticModal
            title={expandedSite.endsWith("-p") ? "Plugin Updates" : "Theme Updates"}
            items={(expandedSite.endsWith("-p") ? site.lastData.plugins : site.lastData.themes)?.filter((item) => item.needs_update) ?? []}
            onClose={() => setExpandedSite(null)}
          />
        );
      })()}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/5">
          <span className="text-xs font-mono text-neutral-500">
            Pagina {page + 1} van {totalPages} &nbsp;·&nbsp; {sites.length} sites
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => goTo((page - 1 + totalPages) % totalPages)}
              className="p-2 rounded-xl bg-white/5 border border-white/10 text-neutral-400 hover:text-white hover:border-white/20 transition-all"
              aria-label="Vorige pagina"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>

            {Array.from({ length: totalPages }).map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`w-7 h-7 rounded-xl text-xs font-black transition-all border ${i === page ? "bg-[#20d67b] text-black border-[#20d67b]" : "bg-white/5 text-neutral-500 border-white/5 hover:border-white/20 hover:text-white"}`}
              >
                {i + 1}
              </button>
            ))}

            <button
              onClick={() => goTo((page + 1) % totalPages)}
              className="p-2 rounded-xl bg-white/5 border border-white/10 text-neutral-400 hover:text-white hover:border-white/20 transition-all"
              aria-label="Volgende pagina"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>

            <button
              onClick={() => setPaused((p) => !p)}
              aria-label={paused ? "Hervat auto-slide" : "Pauzeer auto-slide"}
              className={`ml-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[10px] font-mono uppercase tracking-wider transition-all ${
                paused
                  ? "bg-white/5 border-white/10 text-neutral-500 hover:text-white hover:border-white/20"
                  : "bg-[#20d67b]/10 border-[#20d67b]/20 text-[#20d67b] hover:bg-[#20d67b]/20"
              }`}
            >
              {paused ? (
                <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
              ) : (
                <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
              )}
              {paused ? "paused" : "auto"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Widget ───────────────────────────────────────────────────────────────

export default function SmartWpWidget() {
  const [input, setInput]               = useState("");
  const [inputError, setInputError]     = useState(false);
  const [sites, setSites]               = useState<WpSite[]>([]);
  const [loading, setLoading]           = useState(false);
  const [filter, setFilter]             = useState<FilterType>("all");
  const [layout, setLayout]             = useState<LayoutType>("list");
  const [sortBy, setSortBy]             = useState<SortType>("name");
  const [expandedSite, setExpandedSite] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [healthModal, setHealthModal]   = useState<string | null>(null);
  const [offlineModal, setOfflineModal] = useState<string | null>(null);
  const [lastSync, setLastSync]         = useState<Date | null>(null);
  const [showLog, setShowLog]           = useState(false);
  const [adminKey, setAdminKey]         = useState<string | null>(null);
  const [showAdminKeyModal, setShowAdminKeyModal] = useState(false);
  const pendingRefreshRef = useRef<null | { kind: "all" } | { kind: "domain"; domain: string }>(null);

  // ─── Alert Log ──────────────────────────────────────────────────────────────
  const { log, addEntry, resolveEntry, clearLog } = useAlertLog();

  // ─── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setExpandedSite(null);
        setDeleteConfirm(null);
        setHealthModal(null);
        setOfflineModal(null);
        setShowAdminKeyModal(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem("wp_refresh_admin_key");
      if (v) setAdminKey(v);
    } catch {
      // Ignore.
    }
  }, []);

  // ─── Firebase realtime sync ──────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "wpSites"), (snapshot) => {
      const sitesData = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<WpSite, "id">) }));
      setSites(sitesData);
      setLastSync(new Date());
    });
    return () => unsubscribe();
  }, []);

  // ─── Refresh all sites ───────────────────────────────────────────────────────
  const refreshAllSites = useCallback(async () => {
    if (!sites.length) return;
    setLoading(true);
    try {
      const result = await triggerRefreshAll(adminKey);
      if (result === "unauthorized") {
        pendingRefreshRef.current = { kind: "all" };
        setShowAdminKeyModal(true);
      }
    } finally {
      // UI state updates via Firestore realtime snapshot.
    }
    setLoading(false);
  }, [sites, adminKey]);

  useEffect(() => {
    const interval = setInterval(refreshAllSites, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshAllSites]);

  // ─── Add site ────────────────────────────────────────────────────────────────
  async function handleAddSite() {
    const trimmed = input.trim();
    if (!trimmed) { setInputError(true); setTimeout(() => setInputError(false), 500); return; }
    const domain = trimmed.replace(/^https?:\/\//, "").split("/")[0]?.replace(/\/$/, "") ?? "";
    if (sites.find((s) => s.domain === domain)) return;
    setLoading(true);
    const result = await triggerRefreshDomainWithAuth(domain, adminKey);
    if (result === "ok") {
      setInput("");
    } else if (result === "unauthorized") {
      pendingRefreshRef.current = { kind: "domain", domain };
      setShowAdminKeyModal(true);
    } else {
      setInputError(true);
      setTimeout(() => setInputError(false), 500);
    }
    setLoading(false);
  }

  // ─── Processed sites ─────────────────────────────────────────────────────────
  const processedSites = useMemo(() => {
    return sites
      .filter((s) => {
        if (filter === "all")     return true;
        if (!s.lastData)          return false;
        if (filter === "core")    return s.lastData.core?.needs_update;
        if (filter === "plugins") return s.lastData.plugins?.some((p) => p.needs_update);
        if (filter === "themes")  return s.lastData.themes?.some((t) => t.needs_update);
        if (filter === "http")    return s.lastData.http_health?.has_errors;
        if (filter === "ssl")     return s.lastData.ssl?.status === "critical" || s.lastData.ssl?.status === "error";
        return true;
      })
      .sort((a, b) => {
        if (sortBy === "name") return getSiteName(a).localeCompare(getSiteName(b));
        return getUpdateCount(b) - getUpdateCount(a);
      });
  }, [sites, filter, sortBy]);

  const criticalAlerts = useMemo(() => buildCriticalAlerts(sites), [sites]);

  // ─── Sync alerts → log ───────────────────────────────────────────────────────
  useEffect(() => {
    syncAlertsToLog(criticalAlerts, log, addEntry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [criticalAlerts]);

  const httpErrorSites = useMemo(() => sites.filter((s) => s.lastData?.http_health?.has_errors).length, [sites]);
  const sslErrorSites  = useMemo(() => sites.filter((s) => s.lastData?.ssl?.status === "critical" || s.lastData?.ssl?.status === "error").length, [sites]);

  // Aantal onopgeloste log-entries voor de badge op de knop
  const unresolvedLogCount = useMemo(() => log.filter((e) => !e.resolvedAt).length, [log]);

  return (
    <Card className="col-span-full border-white/5 bg-neutral-900/20">

      {/* Admin Key Modal */}
      {showAdminKeyModal && (
        <div className="fixed inset-0 z-[30000] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md" onClick={() => setShowAdminKeyModal(false)}>
          <div className="bg-neutral-950 border border-white/10 p-8 rounded-[2.5rem] max-w-sm w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-xl font-black text-white italic uppercase tracking-tighter mb-2">Admin key nodig</h4>
            <p className="text-neutral-500 text-xs font-mono mb-6 uppercase tracking-[0.2em] leading-relaxed">Voor refresh/add in productie is een key vereist.</p>
            <input
              type="password"
              value={adminKey ?? ""}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="DASHBOARD_ADMIN_KEY"
              className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-3 text-sm text-[#20d67b] font-mono focus:outline-none focus:border-[#20d67b]/50 transition-all"
            />
            <div className="grid grid-cols-2 gap-4 mt-6">
              <button onClick={() => setShowAdminKeyModal(false)} className="px-6 py-4 rounded-2xl bg-white/5 text-neutral-400 text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-all">Abort</button>
              <button
                onClick={async () => {
                  try {
                    if (adminKey) localStorage.setItem("wp_refresh_admin_key", adminKey);
                  } catch {
                    // Ignore.
                  }
                  setShowAdminKeyModal(false);
                  const pending = pendingRefreshRef.current;
                  pendingRefreshRef.current = null;
                  if (!pending) return;
                  setLoading(true);
                  try {
                    if (pending.kind === "all") {
                      await triggerRefreshAll(adminKey);
                    } else {
                      await triggerRefreshDomainWithAuth(pending.domain, adminKey);
                    }
                  } finally {
                    setLoading(false);
                  }
                }}
                className="px-6 py-4 rounded-2xl bg-[#20d67b] text-black text-xs font-black uppercase tracking-widest hover:opacity-90 transition-all"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[30000] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md">
          <div className="bg-neutral-950 border border-white/10 p-8 rounded-[2.5rem] max-w-sm w-full shadow-2xl animate-in zoom-in-95 duration-200">
            <h4 className="text-xl font-black text-white italic uppercase tracking-tighter mb-2">Verwijderen?</h4>
            <p className="text-neutral-500 text-xs font-mono mb-8 uppercase tracking-[0.2em] leading-relaxed">System purging site from registry...</p>
            <div className="grid grid-cols-2 gap-4">
              <button onClick={() => setDeleteConfirm(null)} className="px-6 py-4 rounded-2xl bg-white/5 text-neutral-400 text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-all">Abort</button>
              <button onClick={() => { deleteSiteFromFirebase(deleteConfirm); setDeleteConfirm(null); }} className="px-6 py-4 rounded-2xl bg-red-500 text-white text-xs font-black uppercase tracking-widest hover:bg-red-600 transition-all">Confirm</button>
            </div>
          </div>
        </div>
      )}

      {/* HTTP Health Modal */}
      {healthModal && (() => {
        const site = sites.find((s) => s.id === healthModal);
        if (!site?.lastData?.http_health) return null;
        return <HttpHealthModal health={site.lastData.http_health} siteName={getSiteName(site)} onClose={() => setHealthModal(null)} />;
      })()}

      {/* Offline Log Modal */}
      {offlineModal && (() => {
        const site = sites.find((s) => s.id === offlineModal);
        if (!site?.lastData?.offline_log) return null;
        return <OfflineLogModal log={site.lastData.offline_log} siteName={getSiteName(site)} onClose={() => setOfflineModal(null)} />;
      })()}

      {/* Toolbar */}
      <div className="flex flex-col space-y-8 mb-10">
        <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-8">
          <div className="space-y-4">
            <h2 className="text-3xl font-black text-white italic uppercase tracking-tighter flex items-center gap-3">
              WP Engine
              <span className="text-neutral-600 text-xl font-mono not-italic ml-1">({sites.length})</span>
              <span className="w-2 h-2 rounded-full bg-[#20d67b] animate-pulse" />
            </h2>
            <div className="flex flex-wrap gap-2">
              {(["all", "core", "plugins", "themes"] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-all border ${filter === f ? "bg-[#20d67b] text-black border-[#20d67b]" : "bg-white/5 text-neutral-400 border-white/5 hover:border-white/20"}`}>{f}</button>
              ))}
              <button onClick={() => setFilter("http")} className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-all border flex items-center gap-2 ${filter === "http" ? "bg-red-500 text-white border-red-500" : httpErrorSites > 0 ? "bg-red-500/10 text-red-400 border-red-500/30 hover:border-red-500/50" : "bg-white/5 text-neutral-400 border-white/5 hover:border-white/20"}`}>
                HTTP
                {httpErrorSites > 0 && <span className={`w-4 h-4 rounded-full text-[9px] flex items-center justify-center font-black ${filter === "http" ? "bg-white text-red-500" : "bg-red-500 text-white"}`}>{httpErrorSites}</span>}
              </button>
              <button onClick={() => setFilter("ssl")} className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-wider transition-all border flex items-center gap-2 ${filter === "ssl" ? "bg-red-500 text-white border-red-500" : sslErrorSites > 0 ? "bg-red-500/10 text-red-400 border-red-500/30 hover:border-red-500/50" : "bg-white/5 text-neutral-400 border-white/5 hover:border-white/20"}`}>
                SSL
                {sslErrorSites > 0 && <span className={`w-4 h-4 rounded-full text-[9px] flex items-center justify-center font-black ${filter === "ssl" ? "bg-white text-red-500" : "bg-red-500 text-white"}`}>{sslErrorSites}</span>}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 w-full xl:w-auto">
            {lastSync && <span className="text-xs text-neutral-500 ml-2">Last sync: {lastSync.toLocaleTimeString()}</span>}

            {/* Alert Log toggle button */}
            <button
              onClick={() => setShowLog((v) => !v)}
              className={`relative flex items-center gap-2 px-4 py-2 rounded-2xl border text-xs font-black uppercase tracking-wider transition-all ${
                showLog
                  ? "bg-[#20d67b]/10 border-[#20d67b]/30 text-[#20d67b]"
                  : "bg-white/5 border-white/5 text-neutral-400 hover:border-white/20 hover:text-white"
              }`}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
              Alert Log
              {unresolvedLogCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-black flex items-center justify-center">
                  {unresolvedLogCount > 9 ? "9+" : unresolvedLogCount}
                </span>
              )}
            </button>

            <button onClick={refreshAllSites} disabled={loading} className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white/5 border border-white/5 text-neutral-400 text-xs font-black uppercase tracking-wider hover:border-white/20 hover:text-white transition-all disabled:opacity-40">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={loading ? "animate-spin" : ""}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              {loading ? "Syncing..." : "Refresh"}
            </button>

            <div className="flex items-center bg-black/40 rounded-2xl p-1.5 border border-white/5">
              <button onClick={() => setLayout("grid")} aria-label="Grid layout" className={`p-2.5 rounded-xl transition-all ${layout === "grid" ? "bg-white/10 text-[#20d67b]" : "text-neutral-600 hover:text-neutral-400"}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
              </button>
              <button onClick={() => setLayout("list")} aria-label="List layout" className={`p-2.5 rounded-xl transition-all ${layout === "list" ? "bg-white/10 text-[#20d67b]" : "text-neutral-600 hover:text-neutral-400"}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              </button>
              <div className="w-[1px] h-4 bg-white/10 mx-2" />
              <button onClick={() => setSortBy((prev) => (prev === "name" ? "updates" : "name"))} className="px-4 text-xs font-black text-neutral-400 uppercase tracking-wider hover:text-white transition-colors">
                Sort: <span className="text-[#20d67b]">{sortBy}</span>
              </button>
            </div>

            <div className="flex gap-2 flex-1 xl:flex-none min-w-[260px]">
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAddSite()} placeholder="domein.nl"
                className={`bg-black/40 border rounded-2xl px-5 py-3 text-sm text-[#20d67b] font-mono focus:outline-none transition-all flex-1 ${inputError ? "border-red-500 animate-shake" : "border-white/10 focus:border-[#20d67b]/50"}`}
              />
              <button onClick={handleAddSite} disabled={loading} className="bg-[#20d67b] text-black px-6 py-3 rounded-2xl text-xs font-black uppercase transition-all hover:shadow-[0_0_20px_rgba(32,214,123,0.3)] disabled:opacity-50">
                {loading ? "..." : "ADD"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      {processedSites.length === 0 ? (
        <div className="py-20 flex flex-col items-center justify-center border border-dashed border-white/5 rounded-[2rem] bg-white/[0.02]">
          <p className="text-neutral-500 text-xs font-black uppercase tracking-[0.2em]">Geen updates gevonden</p>
        </div>

      ) : layout === "grid" ? (

        // ─── Grid ──────────────────────────────────────────────────────────────
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {processedSites.map((s) => (
            <div key={s.id} className="group relative bg-neutral-950/40 border border-white/5 transition-all hover:border-[#20d67b]/30 p-8 rounded-[2rem] flex flex-col">
              <button onClick={() => setDeleteConfirm(s.id)} aria-label={`Verwijder ${s.domain}`} className="absolute top-6 right-6 text-neutral-500 hover:text-white transition-colors z-20">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
              <div className="mb-6">
                <a href={`https://${s.domain}/wp-admin`} target="_blank" rel="noopener noreferrer" className="block transition-all active:scale-95">
                  <h3 className="text-lg font-black text-white italic tracking-tighter uppercase group-hover:text-[#20d67b] transition-colors">{getSiteName(s)}</h3>
                  <p className="text-xs font-mono text-neutral-500 mt-0.5">{s.domain}</p>
                </a>
              </div>
              {isOnline(s) && s.lastData ? (
                <div className="mt-auto flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-white/10">
                      <div className={`w-1.5 h-1.5 rounded-full ${s.lastData.core?.needs_update ? "bg-yellow-500 animate-pulse" : "bg-[#20d67b]"}`} />
                      <span className="text-xs font-mono font-bold text-neutral-300">V{s.lastData.core?.current}</span>
                    </div>
                    {s.lastData.php && (
                      <div className={`flex items-center px-3 py-1.5 rounded-xl border ${s.lastData.php.startsWith("8") ? "bg-white/5 border-white/10 text-neutral-300" : "bg-yellow-500/10 border-yellow-500/20 text-yellow-400"}`}>
                        <span className="text-xs font-mono font-bold">PHP {s.lastData.php}</span>
                      </div>
                    )}
                    <Badge color="custom">{s.status ?? "online"}</Badge>
                    {s.lastData.ssl && <SslBadge ssl={s.lastData.ssl} />}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={(e) => { e.stopPropagation(); if (s.lastData?.plugins?.some((p) => p.needs_update)) setExpandedSite(`${s.id}-p`); }} className={`px-3 py-1.5 rounded-xl border transition-all flex items-center gap-2 text-xs font-black uppercase ${s.lastData.plugins?.some((p) => p.needs_update) ? "bg-[#20d67b]/10 border-[#20d67b]/20 text-[#20d67b] hover:bg-[#20d67b]/20" : "bg-white/5 border-white/5 text-neutral-600 opacity-50"}`}>
                      Plugins <span className="font-mono">{s.lastData.plugins?.filter((p) => p.needs_update).length ?? 0}</span>
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); if (s.lastData?.themes?.some((t) => t.needs_update)) setExpandedSite(`${s.id}-t`); }} className={`px-3 py-1.5 rounded-xl border transition-all flex items-center gap-2 text-xs font-black uppercase ${s.lastData.themes?.some((t) => t.needs_update) ? "bg-pink-500/10 border-pink-500/20 text-pink-500 hover:bg-pink-500/20" : "bg-white/5 border-white/5 text-neutral-600 opacity-50"}`}>
                      Themes <span className="font-mono">{s.lastData.themes?.filter((t) => t.needs_update).length ?? 0}</span>
                    </button>
                    {s.lastData.http_health && <HttpHealthBadge health={s.lastData.http_health} onClick={() => setHealthModal(s.id)} />}
                    {s.lastData.offline_log && (
                      <button onClick={(e) => { e.stopPropagation(); setOfflineModal(s.id); }} className={`${s.lastData.offline_log.total_events > 0 ? badgeOrange : badgeNeutral} hover:opacity-80 transition-all`}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        {s.lastData.offline_log.total_events > 0 ? `${s.lastData.offline_log.total_events} offline` : "Geen offline"}
                      </button>
                    )}
                  </div>
                  {(expandedSite === `${s.id}-p` || expandedSite === `${s.id}-t`) && (
                    <StaticModal
                      title={expandedSite.endsWith("-p") ? "Plugin Updates" : "Theme Updates"}
                      items={(expandedSite.endsWith("-p") ? s.lastData.plugins : s.lastData.themes)?.filter((item) => item.needs_update) ?? []}
                      onClose={() => setExpandedSite(null)}
                    />
                  )}
                </div>
              ) : (
                <span title={offlineReason(s)}>
                  <Badge color="red">Offline</Badge>
                </span>
              )}
            </div>
          ))}
        </div>

      ) : (

        // ─── List / Table + Critical Alerts sidebar ─────────────────────────────
        <div className="flex gap-6 items-start">
          <PaginatedTable
            sites={processedSites}
            onHealthModal={setHealthModal}
            onOfflineModal={setOfflineModal}
            onDeleteConfirm={setDeleteConfirm}
            expandedSite={expandedSite}
            setExpandedSite={setExpandedSite}
          />
          <CriticalAlertsPanel alerts={criticalAlerts} />
        </div>
      )}

      {/* ─── Alert Log (inklapbaar onder het dashboard) ──────────────────────── */}
      {showLog && (
        <div className="mt-10">
          <AlertLogPanel
            log={log}
            onResolve={resolveEntry}
            onClear={clearLog}
          />
        </div>
      )}

    </Card>
  );
}
