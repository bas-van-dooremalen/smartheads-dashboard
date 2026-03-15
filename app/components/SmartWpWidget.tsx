"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { db } from "@/app/lib/firebaseClient";
import {
  deleteSiteFromFirebase,
} from "@/app/lib/wpSites";
import { collection, onSnapshot } from "firebase/firestore";
import Card from "./Card";
import Badge from "./Badge";

// â”€â”€â”€ Config â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const PAGE_SIZE           = 7;
const SLIDE_INTERVAL_MS   = 8_500;

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface WpSiteData {
  site?: string;
  php?: string;
  core?: {
    current?: string;
    needs_update?: boolean;
    [k: string]: unknown;
  };
  themes?: Array<{
    name: string;
    version?: string;
    needs_update?: boolean;
    active?: boolean;
    [k: string]: unknown;
  }>;
  plugins?: Array<{
    name: string;
    version?: string;
    needs_update?: boolean;
    active?: boolean;
    [k: string]: unknown;
  }>;
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

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

function statusLabel(site: WpSite): string {
  return isOnline(site) ? "online" : "offline";
}

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

// (Alert type config/sidebar removed for a simpler table view)

// â”€â”€â”€ Sub-components â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// (Modal helpers removed for a simpler table view)

// (HTTP health badges removed for a simpler table view)

// (HTTP/Offline modals removed for a simpler table view)

// â”€â”€â”€ Critical Alerts Panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// (Critical alerts sidebar removed for a simpler table view)

// â”€â”€â”€ Table with pagination/slides â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function PaginatedTable({
  sites,
  onDeleteConfirm,
}: {
  sites: WpSite[];
  onDeleteConfirm: (id: string) => void;
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
              <th className="px-6 py-4 text-left text-xs font-black uppercase tracking-wider text-neutral-400">Site</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Status</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">PHP</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Core</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Theme</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400">Plugins</th>
              <th className="px-4 py-4 text-center text-xs font-black uppercase tracking-wider text-neutral-400"></th>
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

                {/* Status */}
                <td className="px-4 py-5 text-center">
                  <span title={!isOnline(s) ? offlineReason(s) : undefined}>
                    <Badge color={isOnline(s) ? "custom" : "red"}>{statusLabel(s)}</Badge>
                  </span>
                </td>

                {/* PHP */}
                <td className="px-4 py-5 text-center">
                  <span className="text-xs font-mono text-neutral-300">
                    {s.lastData?.php ?? "—"}
                  </span>
                </td>

                {/* Core */}
                <td className="px-4 py-5 text-center">
                  <span className="text-xs font-mono text-neutral-300">
                    {s.lastData?.core?.current ?? "—"}
                  </span>
                </td>

                {/* Theme */}
                <td className="px-4 py-5 text-center">
                  <span className="text-xs font-mono text-neutral-300">
                    {(() => {
                      const themes = s.lastData?.themes ?? [];
                      const active = themes.find((t) => t.active) ?? themes[0];
                      return active?.version ?? "—";
                    })()}
                  </span>
                </td>

                {/* Plugins */}
                <td className="px-4 py-5 text-center">
                  <span className="text-xs font-mono text-neutral-300">
                    {(() => {
                      const plugins = s.lastData?.plugins ?? [];
                      const total = plugins.length;
                      if (!total) return "—";
                      const updates = plugins.filter((p) => p.needs_update).length;
                      return `${updates}/${total}`;
                    })()}
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/5">
          <span className="text-xs font-mono text-neutral-500">
            Pagina {page + 1} van {totalPages} &nbsp;Â·&nbsp; {sites.length} sites
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

// â”€â”€â”€ Main Widget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function SmartWpWidget() {
  const [input, setInput]               = useState("");
  const [inputError, setInputError]     = useState(false);
  const [sites, setSites]               = useState<WpSite[]>([]);
  const [loading, setLoading]           = useState(false);
  const [layout, setLayout]             = useState<LayoutType>("list");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [lastSync, setLastSync]         = useState<Date | null>(null);
  const [adminKey, setAdminKey]         = useState<string | null>(null);
  const [showAdminKeyModal, setShowAdminKeyModal] = useState(false);
  const pendingRefreshRef = useRef<null | { kind: "all" } | { kind: "domain"; domain: string }>(null);

  // â”€â”€â”€ Keyboard shortcuts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDeleteConfirm(null);
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

  // â”€â”€â”€ Firebase realtime sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "wpSites"), (snapshot) => {
      const sitesData = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<WpSite, "id">) }));
      setSites(sitesData);
      setLastSync(new Date());
    });
    return () => unsubscribe();
  }, []);

  // â”€â”€â”€ Refresh all sites â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // Keep a small gap to avoid spiky traffic and rate limiting.
        await sleep(150);
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

  // â”€â”€â”€ Add site â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€â”€ Processed sites â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const processedSites = useMemo(() => {
    return [...sites].sort((a, b) => getSiteName(a).localeCompare(getSiteName(b)));
  }, [sites]);

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
                      for (const site of sites) {
                        const result = await triggerRefreshDomainWithAuth(
                          site.domain,
                          adminKey
                        );
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

      {/* (HTTP/Offline modals removed) */}

      {/* Toolbar */}
      <div className="flex flex-col space-y-8 mb-10">
        <div className="flex flex-col xl:flex-row justify-between items-start xl:items-center gap-8">
          <div className="space-y-4">
            <h2 className="text-3xl font-black text-white italic uppercase tracking-tighter flex items-center gap-3">
              WP Engine
              <span className="text-neutral-600 text-xl font-mono not-italic ml-1">({sites.length})</span>
              <span className="w-2 h-2 rounded-full bg-[#20d67b] animate-pulse" />
            </h2>
            <div className="flex flex-wrap gap-2" />
          </div>

          <div className="flex flex-wrap items-center gap-4 w-full xl:w-auto">
            {lastSync && <span className="text-xs text-neutral-500 ml-2">Last sync: {lastSync.toLocaleTimeString()}</span>}

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
          <p className="text-neutral-500 text-xs font-black uppercase tracking-[0.2em]">Geen sites gevonden</p>
        </div>

      ) : layout === "grid" ? (

        // â”€â”€â”€ Grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
              <span title={!isOnline(s) ? offlineReason(s) : undefined} className="mt-auto">
                <Badge color={isOnline(s) ? "custom" : "red"}>{statusLabel(s)}</Badge>
              </span>
            </div>
          ))}
        </div>

      ) : (

        // â”€â”€â”€ List / Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        <PaginatedTable
          sites={processedSites}
          onDeleteConfirm={setDeleteConfirm}
        />
      )}

    </Card>
  );
}

