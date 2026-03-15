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

/** Hoe vaak (ms) alle sites automatisch herfetched worden. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Aantal sites per tabel-pagina. */
const PAGE_SIZE = 7;

/** Milliseconden tussen automatische pagina-slides. */
const SLIDE_INTERVAL_MS = 8_500;

// =============================================================================
// Types
// =============================================================================

/** Data zoals teruggegeven door de WordPress plugin (v4.0+). */
interface WpSiteData {
  site?: string;

  /** PHP-versie object (v4.0+). Valt terug op string voor oudere plugin-versies. */
  php?:
    | {
        version: string;
        needs_update: boolean;
        recommended: string;
      }
    | string; // backwards-compat met plugin v3.x

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

  /** Snelle samenvatting – aanwezig in plugin v4.0+. */
  summary?: {
    core_updates: number;
    theme_updates: number;
    plugin_updates: number;
    total_updates: number;
  };
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

type LayoutType = "grid" | "list";

// =============================================================================
// Helpers — versie-extractie
// =============================================================================

/** Haal de leesbare sitenaam op; HTML-entities worden gedecodeerd. */
function getSiteName(site: WpSite): string {
  const raw = site.lastData?.site ?? site.domain;
  if (typeof document === "undefined") return raw;
  const el = document.createElement("textarea");
  el.innerHTML = raw;
  return el.value;
}

/** Is de site bereikbaar? */
function isOnline(site: WpSite): boolean {
  return (site.reachability?.ok ?? site.ok) === true;
}

/** Geeft een leesbare offline-reden terug. */
function offlineReason(site: WpSite): string {
  const r = site.reachability;
  if (!r) return "Site reageert niet";
  if (r.error) return r.error;
  if (r.statusCode !== null) return `HTTP ${r.statusCode}`;
  return "Site reageert niet";
}

/** "online" | "offline" label voor de status-badge. */
function statusLabel(site: WpSite): string {
  return isOnline(site) ? "online" : "offline";
}

// ── PHP ───────────────────────────────────────────────────────────────────────

/** Geeft de PHP-versiestring terug, ongeacht of het object of string is. */
function getPhpVersion(data: WpSiteData | undefined): string {
  if (!data?.php) return "—";
  return typeof data.php === "string" ? data.php : data.php.version;
}

/** True als de PHP-versie als verouderd gemarkeerd is. */
function phpNeedsUpdate(data: WpSiteData | undefined): boolean {
  if (!data?.php || typeof data.php === "string") return false;
  return data.php.needs_update === true;
}

// ── Core ──────────────────────────────────────────────────────────────────────

/** Geeft de huidige WordPress Core-versie terug. */
function getCoreVersion(data: WpSiteData | undefined): string {
  return data?.core?.current ?? "—";
}

/** True als er een Core-update beschikbaar is. */
function coreNeedsUpdate(data: WpSiteData | undefined): boolean {
  return data?.core?.needs_update === true;
}

/** Geeft de nieuwe Core-versie terug als die beschikbaar is. */
function getCoreNewVersion(data: WpSiteData | undefined): string | null {
  return data?.core?.new_version ?? null;
}

// ── Thema ─────────────────────────────────────────────────────────────────────

/** Geeft het actieve thema (of het eerste thema) terug. */
function getActiveTheme(data: WpSiteData | undefined) {
  const themes = data?.themes ?? [];
  return themes.find((t) => t.active) ?? themes[0] ?? null;
}

/** Geeft de versie van het actieve thema terug. */
function getThemeVersion(data: WpSiteData | undefined): string {
  return getActiveTheme(data)?.version ?? "—";
}

/** True als er een thema-update beschikbaar is. */
function themeNeedsUpdate(data: WpSiteData | undefined): boolean {
  return getActiveTheme(data)?.needs_update === true;
}

// ── Plugins ───────────────────────────────────────────────────────────────────

/** Geeft `{ updates, total }` terug voor de plugin-kolom. */
function getPluginStats(data: WpSiteData | undefined): {
  updates: number;
  total: number;
} {
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
//
// Toont een versienummer met een optionele update-indicator.
// Als `needsUpdate` true is, krijgt de cel een oranje/amber kleur en een
// tooltip met de nieuwe versie.
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
      <span
        title={title}
        className="inline-flex items-center gap-1.5 text-xs font-mono text-amber-400"
      >
        {/* Oranje update-dot */}
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
        {version}
      </span>
    );
  }

  return (
    <span className="text-xs font-mono text-neutral-300">{version}</span>
  );
}

// =============================================================================
// Sub-component: PluginCell
//
// Toont "updates/total" voor plugins.
// Als er updates zijn, wordt het getal in amber weergegeven met een dot.
// =============================================================================

function PluginCell({ data }: { data: WpSiteData | undefined }) {
  const { updates, total } = getPluginStats(data);
  if (!total) return <span className="text-xs font-mono text-neutral-500">—</span>;

  if (updates > 0) {
    return (
      <span
        title={`${updates} van ${total} plugins heeft een update`}
        className="inline-flex items-center gap-1.5 text-xs font-mono text-amber-400"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
        {updates}/{total}
      </span>
    );
  }

  return (
    <span className="text-xs font-mono text-neutral-300">
      0/{total}
    </span>
  );
}

// =============================================================================
// Sub-component: PaginatedTable
//
// Tabel met automatische paginering en optionele auto-slide.
// =============================================================================

function PaginatedTable({
  sites,
  onDeleteConfirm,
}: {
  sites: WpSite[];
  onDeleteConfirm: (id: string) => void;
}) {
  const totalPages = Math.ceil(sites.length / PAGE_SIZE);
  const [page, setPage]       = useState(0);
  const [paused, setPaused]   = useState(true);
  const [visible, setVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pageRef  = useRef(page);

  // Houd pageRef synchroon voor gebruik in interval-callbacks
  useEffect(() => { pageRef.current = page; }, [page]);

  // Reset naar pagina 0 als de dataset verandert
  useEffect(() => {
    const t = setTimeout(() => setPage(0), 0);
    return () => clearTimeout(t);
  }, [sites]);

  // Cross-fade naar een nieuwe pagina
  const fadeTo = useCallback((next: number) => {
    setVisible(false);
    setTimeout(() => { setPage(next); setVisible(true); }, 300);
  }, []);

  // Auto-slide timer
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

      {/* ── Tabel ─────────────────────────────────────────────────────────── */}
      <div
        className="overflow-x-auto transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
      >
        <table className="min-w-full divide-y divide-white/10">
          <thead>
            <tr className="bg-neutral-900">
              <th className="px-6 py-4 text-left   text-xs font-black uppercase tracking-wider text-neutral-400">Site</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Status</th>
              {/* PHP — lichte oranje tint als verouderd */}
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">PHP</th>
              {/* WordPress Core-versie */}
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Core</th>
              {/* Actief thema-versie */}
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Theme</th>
              {/* Plugin-updates (X/totaal) */}
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Plugins</th>
              {/* Verwijder-knop */}
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400" />
            </tr>
          </thead>

          <tbody className="bg-neutral-950 divide-y divide-white/10">
            {pageSites.map((s) => (
              <tr key={s.id} className="hover:bg-neutral-900/60 transition-colors">

                {/* ── Site naam + domein ─────────────────────────────────── */}
                <td className="px-6 py-5 whitespace-nowrap">
                  <a
                    href={`https://${s.domain}/wp-admin`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-bold text-base text-white hover:text-[#20d67b] transition-colors"
                  >
                    {getSiteName(s)}
                  </a>
                  <p className="text-xs font-mono text-neutral-500 mt-0.5">{s.domain}</p>
                </td>

                {/* ── Online/Offline status ──────────────────────────────── */}
                <td className="px-4 py-5 text-center">
                  <span title={!isOnline(s) ? offlineReason(s) : undefined}>
                    <Badge color={isOnline(s) ? "custom" : "red"}>
                      {statusLabel(s)}
                    </Badge>
                  </span>
                </td>

                {/* ── PHP versie ─────────────────────────────────────────── */}
                <td className="px-4 py-5 text-center">
                  <VersionCell
                    version={getPhpVersion(s.lastData)}
                    needsUpdate={phpNeedsUpdate(s.lastData)}
                    newVersion={
                      typeof s.lastData?.php === "object"
                        ? s.lastData.php?.recommended
                        : null
                    }
                  />
                </td>

                {/* ── WordPress Core versie ──────────────────────────────── */}
                <td className="px-4 py-5 text-center">
                  <VersionCell
                    version={getCoreVersion(s.lastData)}
                    needsUpdate={coreNeedsUpdate(s.lastData)}
                    newVersion={getCoreNewVersion(s.lastData)}
                  />
                </td>

                {/* ── Actief thema versie ────────────────────────────────── */}
                <td className="px-4 py-5 text-center">
                  <VersionCell
                    version={getThemeVersion(s.lastData)}
                    needsUpdate={themeNeedsUpdate(s.lastData)}
                    newVersion={getActiveTheme(s.lastData)?.new_version}
                  />
                </td>

                {/* ── Plugin-updates teller ──────────────────────────────── */}
                <td className="px-4 py-5 text-center">
                  <PluginCell data={s.lastData} />
                </td>

                {/* ── Verwijder-knop ─────────────────────────────────────── */}
                <td className="px-4 py-5 text-center">
                  <button
                    onClick={() => onDeleteConfirm(s.id)}
                    aria-label={`Verwijder ${s.domain}`}
                    className="text-neutral-500 hover:text-white transition-colors"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Paginering ──────────────────────────────────────────────────────── */}
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
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>

            {Array.from({ length: totalPages }).map((_, i) => (
              <button
                key={i}
                onClick={() => goTo(i)}
                className={`w-7 h-7 rounded-xl text-xs font-black transition-all border ${
                  i === page
                    ? "bg-[#20d67b] text-black border-[#20d67b]"
                    : "bg-white/5 text-neutral-500 border-white/5 hover:border-white/20 hover:text-white"
                }`}
              >
                {i + 1}
              </button>
            ))}

            <button
              onClick={() => goTo((page + 1) % totalPages)}
              className="p-2 rounded-xl bg-white/5 border border-white/10 text-neutral-400 hover:text-white hover:border-white/20 transition-all"
              aria-label="Volgende pagina"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>

            {/* Auto-slide toggle */}
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

// =============================================================================
// Main component: SmartWpWidget
// =============================================================================

export default function SmartWpWidget() {
  const [input, setInput]                   = useState("");
  const [inputError, setInputError]         = useState(false);
  const [sites, setSites]                   = useState<WpSite[]>([]);
  const [loading, setLoading]               = useState(false);
  const [layout, setLayout]                 = useState<LayoutType>("list");
  const [deleteConfirm, setDeleteConfirm]   = useState<string | null>(null);
  const [lastSync, setLastSync]             = useState<Date | null>(null);
  const [adminKey, setAdminKey]             = useState<string | null>(null);
  const [showAdminKeyModal, setShowAdminKeyModal] = useState(false);
  const pendingRefreshRef = useRef<
    null | { kind: "all" } | { kind: "domain"; domain: string }
  >(null);

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDeleteConfirm(null);
        setShowAdminKeyModal(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── Admin key ophalen uit localStorage ────────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem("wp_refresh_admin_key");
      if (stored) setAdminKey(stored);
    } catch { /* Ignore */ }
  }, []);

  // ── Firebase realtime sync ─────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "wpSites"), (snapshot) => {
      const data = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<WpSite, "id">),
      }));
      setSites(data);
      setLastSync(new Date());
    });
    return () => unsubscribe();
  }, []);

  // ── Refresh alle sites ─────────────────────────────────────────────────────
  const refreshAllSites = useCallback(async () => {
    if (!sites.length) return;
    setLoading(true);
    try {
      for (const site of sites) {
        const result = await triggerRefreshDomainWithAuth(site.domain, adminKey);
        if (result === "unauthorized") {
          pendingRefreshRef.current = { kind: "all" };
          setShowAdminKeyModal(true);
          break;
        }
        // Kleine pauze om rate-limiting te voorkomen
        await sleep(150);
      }
    } finally {
      setLoading(false);
    }
  }, [sites, adminKey]);

  // Auto-refresh interval
  useEffect(() => {
    const interval = setInterval(refreshAllSites, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refreshAllSites]);

  // ── Site toevoegen ─────────────────────────────────────────────────────────
  async function handleAddSite() {
    const trimmed = input.trim();
    if (!trimmed) {
      setInputError(true);
      setTimeout(() => setInputError(false), 500);
      return;
    }
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

  // ── Gesorteerde sitelijst ──────────────────────────────────────────────────
  const processedSites = useMemo(
    () => [...sites].sort((a, b) => getSiteName(a).localeCompare(getSiteName(b))),
    [sites]
  );

  // ── Totaal aantal openstaande updates (voor de header-badge) ───────────────
  const totalPendingUpdates = useMemo(() => {
    return processedSites.reduce((acc, s) => {
      return acc + (s.lastData?.summary?.total_updates ?? 0);
    }, 0);
  }, [processedSites]);

  return (
    <Card className="col-span-full border-white/5 bg-neutral-900/20">

      {/* ── Modal: Admin Key ───────────────────────────────────────────────── */}
      {showAdminKeyModal && (
        <div
          className="fixed inset-0 z-[30000] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md"
          onClick={() => setShowAdminKeyModal(false)}
        >
          <div
            className="bg-neutral-950 border border-white/10 p-8 rounded-[2.5rem] max-w-sm w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-xl font-black text-white italic uppercase tracking-tighter mb-2">
              Admin key nodig
            </h4>
            <p className="text-neutral-500 text-xs font-mono mb-6 uppercase tracking-[0.2em] leading-relaxed">
              Voor refresh/add in productie is een key vereist.
            </p>
            <input
              type="password"
              value={adminKey ?? ""}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="DASHBOARD_ADMIN_KEY"
              className="w-full bg-black/40 border border-white/10 rounded-2xl px-5 py-3 text-sm text-[#20d67b] font-mono focus:outline-none focus:border-[#20d67b]/50 transition-all"
            />
            <div className="grid grid-cols-2 gap-4 mt-6">
              <button
                onClick={() => setShowAdminKeyModal(false)}
                className="px-6 py-4 rounded-2xl bg-white/5 text-neutral-400 text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-all"
              >
                Abort
              </button>
              <button
                onClick={async () => {
                  try {
                    if (adminKey) localStorage.setItem("wp_refresh_admin_key", adminKey);
                  } catch { /* Ignore */ }
                  setShowAdminKeyModal(false);
                  const pending = pendingRefreshRef.current;
                  pendingRefreshRef.current = null;
                  if (!pending) return;
                  setLoading(true);
                  try {
                    if (pending.kind === "all") {
                      for (const site of sites) {
                        const result = await triggerRefreshDomainWithAuth(site.domain, adminKey);
                        if (result === "unauthorized") break;
                        await sleep(150);
                      }
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

      {/* ── Modal: Verwijder bevestiging ───────────────────────────────────── */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-[30000] flex items-center justify-center p-6 bg-black/80 backdrop-blur-md">
          <div className="bg-neutral-950 border border-white/10 p-8 rounded-[2.5rem] max-w-sm w-full shadow-2xl animate-in zoom-in-95 duration-200">
            <h4 className="text-xl font-black text-white italic uppercase tracking-tighter mb-2">
              Verwijderen?
            </h4>
            <p className="text-neutral-500 text-xs font-mono mb-8 uppercase tracking-[0.2em] leading-relaxed">
              System purging site from registry...
            </p>
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-6 py-4 rounded-2xl bg-white/5 text-neutral-400 text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-all"
              >
                Abort
              </button>
              <button
                onClick={() => {
                  deleteSiteFromFirebase(deleteConfirm);
                  setDeleteConfirm(null);
                }}
                className="px-6 py-4 rounded-2xl bg-red-500 text-white text-xs font-black uppercase tracking-widest hover:bg-red-600 transition-all"
              >
                Confirm
              </button>
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
              <span className="text-neutral-600 text-xl font-mono not-italic ml-1">
                ({sites.length})
              </span>
              <span className="w-2 h-2 rounded-full bg-[#20d67b] animate-pulse" />

              {/* Totaal aantal openstaande updates over alle sites */}
              {totalPendingUpdates > 0 && (
                <span
                  title={`${totalPendingUpdates} update(s) beschikbaar`}
                  className="ml-1 inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-400 text-black text-[10px] font-black"
                >
                  {totalPendingUpdates}
                </span>
              )}
            </h2>
            <div className="flex flex-wrap gap-2" />
          </div>

          <div className="flex flex-wrap items-center gap-4 w-full xl:w-auto">
            {lastSync && (
              <span className="text-xs text-neutral-500 ml-2">
                Last sync: {lastSync.toLocaleTimeString()}
              </span>
            )}

            {/* Handmatige refresh-knop */}
            <button
              onClick={refreshAllSites}
              disabled={loading}
              className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-white/5 border border-white/5 text-neutral-400 text-xs font-black uppercase tracking-wider hover:border-white/20 hover:text-white transition-all disabled:opacity-40"
            >
              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                className={loading ? "animate-spin" : ""}
              >
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              {loading ? "Syncing..." : "Refresh"}
            </button>

            {/* Grid / List toggle */}
            <div className="flex items-center bg-black/40 rounded-2xl p-1.5 border border-white/5">
              <button
                onClick={() => setLayout("grid")}
                aria-label="Grid layout"
                className={`p-2.5 rounded-xl transition-all ${
                  layout === "grid" ? "bg-white/10 text-[#20d67b]" : "text-neutral-600 hover:text-neutral-400"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" />
                </svg>
              </button>
              <button
                onClick={() => setLayout("list")}
                aria-label="List layout"
                className={`p-2.5 rounded-xl transition-all ${
                  layout === "list" ? "bg-white/10 text-[#20d67b]" : "text-neutral-600 hover:text-neutral-400"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
            </div>

            {/* Domein toevoegen */}
            <div className="flex gap-2 flex-1 xl:flex-none min-w-[260px]">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddSite()}
                placeholder="domein.nl"
                className={`bg-black/40 border rounded-2xl px-5 py-3 text-sm text-[#20d67b] font-mono focus:outline-none transition-all flex-1 ${
                  inputError
                    ? "border-red-500 animate-shake"
                    : "border-white/10 focus:border-[#20d67b]/50"
                }`}
              />
              <button
                onClick={handleAddSite}
                disabled={loading}
                className="bg-[#20d67b] text-black px-6 py-3 rounded-2xl text-xs font-black uppercase transition-all hover:shadow-[0_0_20px_rgba(32,214,123,0.3)] disabled:opacity-50"
              >
                {loading ? "..." : "ADD"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────────────────── */}
      {processedSites.length === 0 ? (

        // Lege staat
        <div className="py-20 flex flex-col items-center justify-center border border-dashed border-white/5 rounded-[2rem] bg-white/[0.02]">
          <p className="text-neutral-500 text-xs font-black uppercase tracking-[0.2em]">
            Geen sites gevonden
          </p>
        </div>

      ) : layout === "grid" ? (

        // ── Grid weergave ───────────────────────────────────────────────────
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {processedSites.map((s) => {
            const updates = s.lastData?.summary?.total_updates ?? 0;
            return (
              <div
                key={s.id}
                className="group relative bg-neutral-950/40 border border-white/5 transition-all hover:border-[#20d67b]/30 p-8 rounded-[2rem] flex flex-col"
              >
                {/* Verwijder-knop */}
                <button
                  onClick={() => setDeleteConfirm(s.id)}
                  aria-label={`Verwijder ${s.domain}`}
                  className="absolute top-6 right-6 text-neutral-500 hover:text-white transition-colors z-20"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>

                {/* Site naam */}
                <div className="mb-4">
                  <a
                    href={`https://${s.domain}/wp-admin`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block transition-all active:scale-95"
                  >
                    <h3 className="text-lg font-black text-white italic tracking-tighter uppercase group-hover:text-[#20d67b] transition-colors">
                      {getSiteName(s)}
                    </h3>
                    <p className="text-xs font-mono text-neutral-500 mt-0.5">{s.domain}</p>
                  </a>
                </div>

                {/* Versie-info in grid */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 mb-4 text-xs font-mono text-neutral-500">
                  <span>PHP <VersionCell version={getPhpVersion(s.lastData)} needsUpdate={phpNeedsUpdate(s.lastData)} /></span>
                  <span>WP <VersionCell version={getCoreVersion(s.lastData)} needsUpdate={coreNeedsUpdate(s.lastData)} newVersion={getCoreNewVersion(s.lastData)} /></span>
                </div>

                {/* Status badge + update-teller */}
                <div className="mt-auto flex items-center justify-between">
                  <span title={!isOnline(s) ? offlineReason(s) : undefined}>
                    <Badge color={isOnline(s) ? "custom" : "red"}>{statusLabel(s)}</Badge>
                  </span>
                  {updates > 0 && (
                    <span className="text-[10px] font-mono text-amber-400">
                      {updates} update{updates !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

      ) : (

        // ── Lijst / Tabel weergave ──────────────────────────────────────────
        <PaginatedTable
          sites={processedSites}
          onDeleteConfirm={setDeleteConfirm}
        />
      )}

    </Card>
  );
}