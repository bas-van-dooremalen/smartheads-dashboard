"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/app/lib/firebaseClient";
import { deleteSiteFromFirebase } from "@/app/lib/wpSites";
import { collection, onSnapshot } from "firebase/firestore";
import Card from "./Card";
import Badge from "./Badge";

// =============================================================================
// Config
// =============================================================================

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 7;
const SLIDE_INTERVAL_MS = 8_500;

// =============================================================================
// Types
// =============================================================================

interface WpSiteData {
  site?: string;
  php?:
    | { version: string; needs_update: boolean; recommended: string }
    | string;
  core?: {
    current?: string;
    needs_update?: boolean;
    new_version?: string | null;
    [k: string]: unknown;
  };
  themes?: Array<{
    name: string;
    version?: string;
    needs_update?: boolean;
    new_version?: string | null;
    active?: boolean;
    [k: string]: unknown;
  }>;
  plugins?: Array<{
    name: string;
    version?: string;
    needs_update?: boolean;
    new_version?: string | null;
    active?: boolean;
    [k: string]: unknown;
  }>;
  summary?: {
    core_updates: number;
    theme_updates: number;
    plugin_updates: number;
    total_updates: number;
  };
}

interface SslData {
  valid: boolean;
  days_remaining: number | null;
  expiry_date: string | null;
  status: "ok" | "warning" | "critical" | "error";
  message: string;
}

interface WpSite {
  id: string;
  domain: string;
  ok: boolean;
  status?: string;
  lastData?: WpSiteData;
  ssl?: SslData;
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

type LayoutType = "grid" | "list";

// =============================================================================
// Helpers
// =============================================================================

function getSiteName(site: WpSite): string {
  const raw = site.lastData?.site ?? site.domain;
  if (typeof document === "undefined") return raw;
  const el = document.createElement("textarea");
  el.innerHTML = raw;
  return el.value;
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

function statusLabel(site: WpSite): string {
  return isOnline(site) ? "online" : "offline";
}

function getPhpVersion(data: WpSiteData | undefined): string {
  if (!data?.php) return "—";
  return typeof data.php === "string" ? data.php : data.php.version;
}

function phpNeedsUpdate(data: WpSiteData | undefined): boolean {
  if (!data?.php || typeof data.php === "string") return false;
  return data.php.needs_update === true;
}

function getCoreVersion(data: WpSiteData | undefined): string {
  return data?.core?.current ?? "—";
}

function coreNeedsUpdate(data: WpSiteData | undefined): boolean {
  return data?.core?.needs_update === true;
}

function getCoreNewVersion(data: WpSiteData | undefined): string | null {
  return data?.core?.new_version ?? null;
}

function getActiveTheme(data: WpSiteData | undefined) {
  const themes = data?.themes ?? [];
  return themes.find((t) => t.active) ?? themes[0] ?? null;
}

function getThemeVersion(data: WpSiteData | undefined): string {
  return getActiveTheme(data)?.version ?? "—";
}

function themeNeedsUpdate(data: WpSiteData | undefined): boolean {
  return getActiveTheme(data)?.needs_update === true;
}

function getPluginStats(data: WpSiteData | undefined): { updates: number; total: number } {
  const plugins = data?.plugins ?? [];
  return {
    total: plugins.length,
    updates: plugins.filter((p) => p.needs_update).length,
  };
}

// =============================================================================
// Helpers — netwerk
// =============================================================================

type RefreshResult = "ok" | "unauthorized" | "error";

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

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Sub-component: VersionCell
// =============================================================================

function VersionCell({
  version,
  needsUpdate,
  newVersion,
}: {
  version: string;
  needsUpdate: boolean;
  newVersion?: string | null;
}) {
  const title = needsUpdate && newVersion ? `Update beschikbaar: ${newVersion}` : undefined;
  if (needsUpdate) {
    return (
      <span title={title} className="inline-flex items-center gap-1 text-xs font-mono text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
        {version}
      </span>
    );
  }
  return <span className="text-xs font-mono text-neutral-300">{version}</span>;
}

// =============================================================================
// Sub-component: PluginCell
// =============================================================================

function PluginCell({ data, onClick }: { data: WpSiteData | undefined; onClick?: () => void }) {
  const { updates, total } = getPluginStats(data);
  if (!total) return <span className="text-xs font-mono text-neutral-500">—</span>;
  if (updates > 0) {
    return (
      <span
        title={`${updates} van ${total} plugins heeft een update`}
        onClick={onClick}
        className="inline-flex items-center gap-1 text-xs font-mono text-amber-400 cursor-pointer hover:text-amber-300 transition-colors"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
        {updates}/{total}
      </span>
    );
  }
  return <span className="text-xs font-mono text-neutral-300">0/{total}</span>;
}

// =============================================================================
// Sub-component: SslCell
// =============================================================================

function SslCell({ ssl }: { ssl: SslData | undefined }) {
  if (!ssl) return <span className="text-xs font-mono text-neutral-500">—</span>;
  if (ssl.status === "ok") {
    return <span title={ssl.message} className="text-xs font-mono text-[#20d67b]">{ssl.days_remaining}d</span>;
  }
  if (ssl.status === "warning") {
    return (
      <span title={ssl.message} className="inline-flex items-center gap-1 text-xs font-mono text-amber-400">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />{ssl.days_remaining}d
      </span>
    );
  }
  return (
    <span title={ssl.message} className="inline-flex items-center gap-1 text-xs font-mono text-red-400">
      <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
      {ssl.days_remaining !== null ? `${ssl.days_remaining}d` : "!"}
    </span>
  );
}

// =============================================================================
// Sub-component: UpdatePanel
// =============================================================================

function UpdatePanel({ site, onClose }: { site: WpSite; onClose: () => void }) {
  const data = site.lastData;

  const coreUpdate = data?.core?.needs_update ? {
    current: data.core.current ?? "—",
    new_version: data.core.new_version ?? "—",
  } : null;

  const themeUpdates = (data?.themes ?? []).filter((t) => t.needs_update);
  const pluginUpdates = (data?.plugins ?? []).filter((p) => p.needs_update);
  const totalUpdates = (coreUpdate ? 1 : 0) + themeUpdates.length + pluginUpdates.length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-lg font-black text-white italic uppercase tracking-tighter">{getSiteName(site)}</h3>
          <p className="text-xs font-mono text-neutral-500 mt-0.5">{site.domain}</p>
        </div>
        <button onClick={onClose} className="text-neutral-500 hover:text-white transition-colors mt-1" aria-label="Sluit paneel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="mb-6">
        <span className="inline-flex items-center justify-center px-3 py-1 rounded-full bg-amber-400/10 border border-amber-400/20 text-amber-400 text-[10px] font-black uppercase tracking-widest">
          {totalUpdates} update{totalUpdates !== 1 ? "s" : ""} beschikbaar
        </span>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto flex-1 pr-1">
        {coreUpdate && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-neutral-500 mb-2">WordPress Core</p>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-neutral-400">{coreUpdate.current}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-amber-400 shrink-0 mx-2">
                <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
              </svg>
              <span className="text-xs font-mono text-amber-400 font-bold">{coreUpdate.new_version}</span>
            </div>
          </div>
        )}

        {themeUpdates.length > 0 && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-neutral-500 mb-2">Thema{themeUpdates.length > 1 ? "'s" : ""}</p>
            <div className="flex flex-col gap-2">
              {themeUpdates.map((t, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-xs font-mono text-neutral-300 truncate mr-2">{t.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono text-neutral-500">{t.version ?? "—"}</span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-amber-400">
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                    <span className="text-xs font-mono text-amber-400 font-bold">{t.new_version ?? "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {pluginUpdates.length > 0 && (
          <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
            <p className="text-[10px] font-black uppercase tracking-widest text-neutral-500 mb-2">Plugin{pluginUpdates.length > 1 ? "s" : ""} ({pluginUpdates.length})</p>
            <div className="flex flex-col gap-2">
              {pluginUpdates.map((p, i) => (
                <div key={i} className="flex items-center justify-between">
                  <span className="text-xs font-mono text-neutral-300 truncate mr-2">{p.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-mono text-neutral-500">{p.version ?? "—"}</span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-amber-400">
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                    <span className="text-xs font-mono text-amber-400 font-bold">{p.new_version ?? "—"}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {totalUpdates === 0 && (
          <p className="text-xs font-mono text-neutral-500 text-center py-8">Geen updates beschikbaar.</p>
        )}
      </div>

      <div className="mt-6 pt-4 border-t border-white/5">
        <a
          href={`https://${site.domain}/wp-admin/update-core.php`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 w-full px-4 py-3 rounded-2xl bg-[#20d67b] text-black text-xs font-black uppercase tracking-widest hover:opacity-90 transition-all"
        >
          Open WP Admin
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="7" y1="17" x2="17" y2="7" /><polyline points="7 7 17 7 17 17" />
          </svg>
        </a>
      </div>
    </div>
  );
}

// =============================================================================
// Sub-component: PaginatedTable
// =============================================================================

function PaginatedTable({
  sites,
  onDeleteConfirm,
  onSelectSite,
  selectedSiteId,
}: {
  sites: WpSite[];
  onDeleteConfirm: (id: string) => void;
  onSelectSite: (site: WpSite) => void;
  selectedSiteId: string | null;
}) {
  const totalPages = Math.ceil(sites.length / PAGE_SIZE);
  const [page, setPage]       = useState(0);
  const [paused, setPaused]   = useState(true);
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pageRef  = useRef(page);

  useEffect(() => { pageRef.current = page; }, [page]);

  useEffect(() => {
    const t = setTimeout(() => setPage(0), 0);
    return () => clearTimeout(t);
  }, [sites]);

  const fadeTo = useCallback((next: number) => {
    setVisible(false);
    setTimeout(() => { setPage(next); setVisible(true); }, 300);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (totalPages <= 1 || paused) return;
    timerRef.current = setInterval(
      () => fadeTo((pageRef.current + 1) % totalPages),
      SLIDE_INTERVAL_MS
    );
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [totalPages, paused, fadeTo]);

  const goTo = (p: number) => {
    if (timerRef.current) clearInterval(timerRef.current);
    fadeTo(p);
    if (!paused && totalPages > 1) {
      timerRef.current = setInterval(
        () => fadeTo((pageRef.current + 1) % totalPages),
        SLIDE_INTERVAL_MS
      );
    }
  };

  const pageSites = sites.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="flex flex-col flex-1 min-w-0">
      <div className="overflow-x-auto transition-opacity duration-300" style={{ opacity: visible ? 1 : 0 }}>
        <table className="min-w-full divide-y divide-white/10">
          <thead>
            <tr className="bg-neutral-900">
              <th className="px-6 py-4 text-left   text-xs font-black uppercase tracking-wider text-neutral-400">Site</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Status</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">PHP</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Core</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Theme</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Plugins</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">SSL</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400" />
            </tr>
          </thead>
          <tbody className="bg-neutral-950 divide-y divide-white/10">
            {pageSites.map((s) => {
              const isSelected = s.id === selectedSiteId;
              const hasUpdates = (s.lastData?.summary?.total_updates ?? 0) > 0;
              return (
                <tr key={s.id} className={`transition-colors ${isSelected ? "bg-neutral-800/60" : "hover:bg-neutral-900/60"}`}>
                  <td className="px-6 py-5 whitespace-nowrap">
                    <a href={`https://${s.domain}/wp-admin`} target="_blank" rel="noopener noreferrer" className="font-bold text-base text-white hover:text-[#20d67b] transition-colors">
                      {getSiteName(s)}
                    </a>
                    <p className="text-xs font-mono text-neutral-500 mt-0.5">{s.domain}</p>
                  </td>
                  <td className="px-4 py-5 text-center">
                    <span title={!isOnline(s) ? offlineReason(s) : undefined}>
                      <Badge color={isOnline(s) ? "custom" : "red"}>{statusLabel(s)}</Badge>
                    </span>
                  </td>
                  <td className="px-4 py-5 text-center">
                    <VersionCell version={getPhpVersion(s.lastData)} needsUpdate={phpNeedsUpdate(s.lastData)} newVersion={typeof s.lastData?.php === "object" ? s.lastData.php?.recommended : null} />
                  </td>
                  <td className="px-4 py-5 text-center">
                    <span onClick={() => hasUpdates && onSelectSite(s)} className={hasUpdates ? "cursor-pointer" : ""}>
                      <VersionCell version={getCoreVersion(s.lastData)} needsUpdate={coreNeedsUpdate(s.lastData)} newVersion={getCoreNewVersion(s.lastData)} />
                    </span>
                  </td>
                  <td className="px-4 py-5 text-center">
                    <span onClick={() => hasUpdates && onSelectSite(s)} className={hasUpdates ? "cursor-pointer" : ""}>
                      <VersionCell version={getThemeVersion(s.lastData)} needsUpdate={themeNeedsUpdate(s.lastData)} newVersion={getActiveTheme(s.lastData)?.new_version} />
                    </span>
                  </td>
                  <td className="px-4 py-5 text-center">
                    <PluginCell data={s.lastData} onClick={() => hasUpdates && onSelectSite(s)} />
                  </td>
                  <td className="px-4 py-5 text-center">
                    <SslCell ssl={s.ssl} />
                  </td>
                  <td className="px-4 py-5 text-center">
                    <button onClick={() => onDeleteConfirm(s.id)} aria-label={`Verwijder ${s.domain}`} className="text-neutral-500 hover:text-white transition-colors">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/5">
          <span className="text-xs font-mono text-neutral-500">Pagina {page + 1} van {totalPages} &nbsp;·&nbsp; {sites.length} sites</span>
          <div className="flex items-center gap-2">
            <button onClick={() => goTo((page - 1 + totalPages) % totalPages)} className="p-2 rounded-xl bg-white/5 border border-white/10 text-neutral-400 hover:text-white hover:border-white/20 transition-all" aria-label="Vorige pagina">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
            {Array.from({ length: totalPages }).map((_, i) => (
              <button key={i} onClick={() => goTo(i)} className={`w-7 h-7 rounded-xl text-xs font-black transition-all border ${i === page ? "bg-[#20d67b] text-black border-[#20d67b]" : "bg-white/5 text-neutral-500 border-white/5 hover:border-white/20 hover:text-white"}`}>
                {i + 1}
              </button>
            ))}
            <button onClick={() => goTo((page + 1) % totalPages)} className="p-2 rounded-xl bg-white/5 border border-white/10 text-neutral-400 hover:text-white hover:border-white/20 transition-all" aria-label="Volgende pagina">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
            <button
              onClick={() => setPaused((p) => !p)}
              aria-label={paused ? "Hervat auto-slide" : "Pauzeer auto-slide"}
              className={`ml-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[10px] font-mono uppercase tracking-wider transition-all ${paused ? "bg-white/5 border-white/10 text-neutral-500 hover:text-white hover:border-white/20" : "bg-[#20d67b]/10 border-[#20d67b]/20 text-[#20d67b] hover:bg-[#20d67b]/20"}`}
            >
              {paused ? <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg> : <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>}
              {paused ? "paused" : "auto"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Main component: SmartWpWidget
// =============================================================================

export default function SmartWpWidget() {
  const [input, setInput]                   = useState("");
  const [inputError, setInputError]         = useState(false);
  const [domainQuery, setDomainQuery]       = useState("");
  const [sites, setSites]                   = useState<WpSite[]>([]);
  const [loading, setLoading]               = useState(false);
  const [layout, setLayout]                 = useState<LayoutType>("list");
  const [deleteConfirm, setDeleteConfirm]   = useState<string | null>(null);
  const [lastSync, setLastSync]             = useState<Date | null>(null);
  const [adminKey, setAdminKey]             = useState<string | null>(null);
  const [showAdminKeyModal, setShowAdminKeyModal] = useState(false);
  const [selectedSite, setSelectedSite]     = useState<WpSite | null>(null);
  const pendingRefreshRef = useRef<null | { kind: "all" } | { kind: "domain"; domain: string }>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setDeleteConfirm(null); setShowAdminKeyModal(false); setSelectedSite(null); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("wp_refresh_admin_key");
      if (stored) setAdminKey(stored);
    } catch { /* Ignore */ }
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "wpSites"), (snapshot) => {
      const data = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<WpSite, "id">) }));
      setSites(data);
      setLastSync(new Date());
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!selectedSite) return;
    const updated = sites.find((s) => s.id === selectedSite.id);
    if (updated) setSelectedSite(updated);
  }, [sites]);

  const refreshAllSites = useCallback(async () => {
    if (!sites.length) return;
    setLoading(true);
    try {
      for (const site of sites) {
        const result = await triggerRefreshDomainWithAuth(site.domain, adminKey);
        if (result === "unauthorized") { pendingRefreshRef.current = { kind: "all" }; setShowAdminKeyModal(true); break; }
        await sleep(150);
      }
    } finally { setLoading(false); }
  }, [sites, adminKey]);

  useEffect(() => {
    const interval = setInterval(refreshAllSites, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshAllSites]);

  async function handleAddSite() {
    const trimmed = input.trim();
    if (!trimmed) { setInputError(true); setTimeout(() => setInputError(false), 500); return; }
    const domain = trimmed.replace(/^https?:\/\//, "").split("/")[0]?.replace(/\/$/, "") ?? "";
    if (sites.find((s) => s.domain === domain)) return;
    setLoading(true);
    const result = await triggerRefreshDomainWithAuth(domain, adminKey);
    if (result === "ok") { setInput(""); }
    else if (result === "unauthorized") { pendingRefreshRef.current = { kind: "domain", domain }; setShowAdminKeyModal(true); }
    else { setInputError(true); setTimeout(() => setInputError(false), 500); }
    setLoading(false);
  }

  const processedSites = useMemo(() => {
    const normalizedQuery = domainQuery.trim().toLowerCase();
    const sorted = [...sites].sort((a, b) => getSiteName(a).localeCompare(getSiteName(b)));
    if (!normalizedQuery) return sorted;
    return sorted.filter((s) => s.domain.toLowerCase().includes(normalizedQuery));
  }, [sites, domainQuery]);

  useEffect(() => {
    if (!selectedSite) return;
    if (!processedSites.find((s) => s.id === selectedSite.id)) setSelectedSite(null);
  }, [processedSites, selectedSite]);

  return (
    <Card className="col-span-full border-white/5 bg-neutral-900/20">

      {/* ── Modal: Admin Key ───────────────────────────────────────────────── */}
      {showAdminKeyModal && (
        <div className="fixed inset-0 z-[30000] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md" onClick={() => setShowAdminKeyModal(false)}>
          <div className="bg-neutral-950 border border-white/10 p-8 rounded-[2.5rem] max-w-sm w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-xl font-black text-white italic uppercase tracking-tighter mb-2">Admin key nodig</h4>
            <p className="text-neutral-500 text-xs font-mono mb-6 uppercase tracking-[0.2em] leading-relaxed">Voor refresh/add in productie is een key vereist.</p>
            <input type="password" value={adminKey ?? ""} onChange={(e) => setAdminKey(e.target.value)} placeholder="DASHBOARD_ADMIN_KEY" className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-3 text-sm text-[#20d67b] font-mono focus:outline-none focus:border-[#20d67b]/50 transition-all" />
            <div className="grid grid-cols-2 gap-4 mt-6">
              <button onClick={() => setShowAdminKeyModal(false)} className="px-6 py-4 rounded-2xl bg-white/5 text-neutral-400 text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-all">Abort</button>
              <button
                onClick={async () => {
                  try { if (adminKey) localStorage.setItem("wp_refresh_admin_key", adminKey); } catch { /* Ignore */ }
                  setShowAdminKeyModal(false);
                  const pending = pendingRefreshRef.current; pendingRefreshRef.current = null;
                  if (!pending) return;
                  setLoading(true);
                  try {
                    if (pending.kind === "all") { for (const site of sites) { const r = await triggerRefreshDomainWithAuth(site.domain, adminKey); if (r === "unauthorized") break; await sleep(150); } }
                    else { await triggerRefreshDomainWithAuth(pending.domain, adminKey); }
                  } finally { setLoading(false); }
                }}
                className="px-6 py-4 rounded-2xl bg-[#20d67b] text-black text-xs font-black uppercase tracking-widest hover:opacity-90 transition-all"
              >Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Verwijder bevestiging ───────────────────────────────────── */}
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

      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="flex flex-col space-y-8 mb-10">
        <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-8">
          <div className="space-y-4">
            <h2 className="text-3xl font-black text-white italic uppercase tracking-tighter flex items-center gap-3">
              WP Engine
              <span className="text-neutral-600 text-xl font-mono not-italic ml-1">({sites.length})</span>
              <span className="w-2 h-2 rounded-full bg-[#20d67b] animate-pulse" />
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-4 w-full xl:w-auto">
            {lastSync && <span className="text-xs text-neutral-500 ml-2">Last sync: {lastSync.toLocaleTimeString()}</span>}
            <button onClick={refreshAllSites} disabled={loading} className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white/5 border border-white/5 text-neutral-400 text-xs font-black uppercase tracking-wider hover:border-white/20 hover:text-white transition-all disabled:opacity-40">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={loading ? "animate-spin" : ""}>
                <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              {loading ? "Syncing..." : "Refresh"}
            </button>
            <div className="flex items-center bg-black/40 rounded-2xl p-1.5 border border-white/5">
              <button onClick={() => setLayout("grid")} aria-label="Grid layout" className={`p-2.5 rounded-xl transition-all ${layout === "grid" ? "bg-white/10 text-[#20d67b]" : "text-neutral-600 hover:text-neutral-400"}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                </svg>
              </button>
              <button onClick={() => setLayout("list")} aria-label="List layout" className={`p-2.5 rounded-xl transition-all ${layout === "list" ? "bg-white/10 text-[#20d67b]" : "text-neutral-600 hover:text-neutral-400"}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>
            <div className="flex gap-2 flex-1 xl:flex-none min-w-[260px]">
              <div className="flex items-center bg-black/40 rounded-2xl px-4 py-3 border border-white/10 flex-1">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-600 shrink-0">
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  value={domainQuery}
                  onChange={(e) => setDomainQuery(e.target.value)}
                  placeholder="Zoek domein..."
                  className="bg-transparent ml-3 text-sm text-[#20d67b] font-mono w-full focus:outline-none placeholder:text-neutral-600"
                  aria-label="Zoek op domein"
                />
              </div>
              <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleAddSite()} placeholder="domein.nl" className={`bg-black/40 border rounded-2xl px-5 py-3 text-sm text-[#20d67b] font-mono focus:outline-none transition-all w-[180px] ${inputError ? "border-red-500 animate-shake" : "border-white/10 focus:border-[#20d67b]/50"}`} />
              <button onClick={handleAddSite} disabled={loading} className="bg-[#20d67b] text-black px-6 py-3 rounded-2xl text-xs font-black uppercase transition-all hover:shadow-[0_0_20px_rgba(32,214,123,0.3)] disabled:opacity-50">
                {loading ? "..." : "ADD"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {processedSites.length === 0 ? (
        <div className="py-20 flex flex-col items-center justify-center border border-dashed border-white/5 rounded-[2rem] bg-white/[0.02]">
          <p className="text-neutral-500 text-xs font-black uppercase tracking-[0.2em]">Geen sites gevonden</p>
        </div>

      ) : layout === "grid" ? (
        <div className="flex gap-4">

          {/* ── Grid kaarten ─────────────────────────────────────────────── */}
          <div className={`grid gap-3 flex-1 transition-all duration-300 ${
            selectedSite
              ? "grid-cols-2 md:grid-cols-3 xl:grid-cols-4"
              : "grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
          }`}>
            {processedSites.map((s) => {
              const updates = s.lastData?.summary?.total_updates ?? 0;
              const isSelected = s.id === selectedSite?.id;
              return (
                <div
                  key={s.id}
                  className={`group relative bg-neutral-950/40 border transition-all rounded-2xl flex flex-col ${
                    isSelected
                      ? "border-[#20d67b]/40 bg-neutral-900/40"
                      : "border-white/5 hover:border-white/10"
                  }`}
                >
                  {/* Verwijder-knop */}
                  <button
                    onClick={() => setDeleteConfirm(s.id)}
                    aria-label={`Verwijder ${s.domain}`}
                    className="absolute top-3 right-3 text-neutral-600 hover:text-white transition-colors z-20"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>

                  {/* Klikbaar gebied */}
                  <div
                    className="p-4 flex flex-col gap-3 cursor-pointer flex-1"
                    onClick={() => updates > 0 && setSelectedSite(isSelected ? null : s)}
                  >
                    {/* Site naam + status */}
                    <div className="pr-4">
                      <p className="text-sm font-black text-white italic tracking-tight uppercase leading-tight truncate">
                        {getSiteName(s)}
                      </p>
                      <p className="text-[10px] font-mono text-neutral-600 mt-0.5 truncate">{s.domain}</p>
                    </div>

                    {/* Status + updates */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span title={!isOnline(s) ? offlineReason(s) : undefined}>
                        <Badge color={isOnline(s) ? "custom" : "red"}>{statusLabel(s)}</Badge>
                      </span>
                      {updates > 0 && (
                        <span className="text-[10px] font-black text-amber-400 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded-full">
                          {updates}
                        </span>
                      )}
                    </div>

                    {/* Versie info — compact raster */}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-wider text-neutral-600 mb-0.5">PHP</p>
                        <VersionCell version={getPhpVersion(s.lastData)} needsUpdate={phpNeedsUpdate(s.lastData)} newVersion={typeof s.lastData?.php === "object" ? s.lastData.php?.recommended : null} />
                      </div>
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-wider text-neutral-600 mb-0.5">Core</p>
                        <VersionCell version={getCoreVersion(s.lastData)} needsUpdate={coreNeedsUpdate(s.lastData)} newVersion={getCoreNewVersion(s.lastData)} />
                      </div>
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-wider text-neutral-600 mb-0.5">Theme</p>
                        <VersionCell version={getThemeVersion(s.lastData)} needsUpdate={themeNeedsUpdate(s.lastData)} newVersion={getActiveTheme(s.lastData)?.new_version} />
                      </div>
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-wider text-neutral-600 mb-0.5">Plugins</p>
                        <PluginCell data={s.lastData} />
                      </div>
                      <div className="col-span-2">
                        <p className="text-[9px] font-black uppercase tracking-wider text-neutral-600 mb-0.5">SSL</p>
                        <SslCell ssl={s.ssl} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Slide-in update paneel ────────────────────────────────────── */}
          <div className={`transition-all duration-300 overflow-hidden shrink-0 ${selectedSite ? "w-72 opacity-100" : "w-0 opacity-0 pointer-events-none"}`}>
            {selectedSite && (
              <div className="w-72 bg-neutral-950/80 border border-white/10 rounded-[2rem] p-6 h-fit">
                <UpdatePanel site={selectedSite} onClose={() => setSelectedSite(null)} />
              </div>
            )}
          </div>
        </div>

      ) : (

        // ── Lijst / Tabel weergave ──────────────────────────────────────────
        <div className="flex gap-6">
          <div className="flex-1 min-w-0">
            <PaginatedTable
              sites={processedSites}
              onDeleteConfirm={setDeleteConfirm}
              onSelectSite={(s) => setSelectedSite(selectedSite?.id === s.id ? null : s)}
              selectedSiteId={selectedSite?.id ?? null}
            />
          </div>
          <div className={`transition-all duration-300 overflow-hidden shrink-0 ${selectedSite ? "w-80 opacity-100" : "w-0 opacity-0 pointer-events-none"}`}>
            {selectedSite && (
              <div className="w-80 bg-neutral-950/80 border border-white/10 rounded-[2rem] p-6">
                <UpdatePanel site={selectedSite} onClose={() => setSelectedSite(null)} />
              </div>
            )}
          </div>
        </div>
      )}

    </Card>
  );
}
