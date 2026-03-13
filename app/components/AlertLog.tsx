"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "warning" | "info";
export type AlertCategory = "offline" | "http" | "ssl" | "tls" | "offline_event" | "update";

export interface AlertLogEntry {
  id: string;               // unieke ID per log-regel
  timestamp: number;        // Unix ms
  siteId: string;
  siteName: string;
  domain: string;
  category: AlertCategory;
  severity: AlertSeverity;

  // Wat er mis is
  label: string;            // korte titel
  detail: string;           // details (status code, dagen, etc.)

  // Waarom het fout ging
  rootCause: string;        // oorzaak uitgelegd
  technicalDetail: string;  // raw technische info

  // Hoe te voorkomen
  prevention: string;       // concrete preventiestap
  actionUrl: string;        // directe link

  // Opgelost?
  resolvedAt?: number;
}

// ─── Config ────────────────────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 500;
const LOG_KEY = "wp_alert_log_v1";

// ─── Root cause analysis ───────────────────────────────────────────────────────

function analyzeRootCause(entry: Omit<AlertLogEntry, "id" | "timestamp" | "rootCause" | "technicalDetail" | "prevention" | "actionUrl">): {
  rootCause: string;
  technicalDetail: string;
  prevention: string;
  actionUrl: string;
} {
  switch (entry.category) {
    case "offline":
      return {
        rootCause: "De server reageert niet op HTTP-verzoeken. Mogelijke oorzaken: server crash, geheugen vol, PHP-fatal error, of hosting-provider storing.",
        technicalDetail: `Site ${entry.domain} geeft geen geldig HTTP-antwoord. De monitoring-check heeft de verbinding verbroken na timeout (60s).`,
        prevention: "Schakel uptime-monitoring in met SMS-alert. Controleer server error logs (/var/log/nginx/error.log of Apache equivalent). Stel automatische herstart in voor PHP-FPM.",
        actionUrl: `https://${entry.domain}/wp-admin`,
      };

    case "http":
      return {
        rootCause: "Eén of meer pagina's retourneren een HTTP-foutcode (4xx/5xx). Veelvoorkomende oorzaken: verwijderde pagina's zonder redirect, plugin-conflict, of kapotte template-links.",
        technicalDetail: `HTTP health check detecteerde fouten op ${entry.domain}. Status: ${entry.detail}. Foutieve URL's zijn zichtbaar in het HTTP Health detail-scherm.`,
        prevention: "Installeer een redirect-plugin (Redirection) voor verwijderde pagina's. Controleer na elke plugin-update de HTTP health. Gebruik Google Search Console voor crawl-fouten.",
        actionUrl: `https://${entry.domain}/wp-admin/admin.php?page=redirection.php`,
      };

    case "ssl":
      if (entry.detail.toLowerCase().includes("ongeldig") || entry.detail.toLowerCase().includes("fout")) {
        return {
          rootCause: "Het SSL-certificaat is ongeldig of verlopen. Bezoekers zien een beveiligingswaarschuwing in hun browser, wat leidt tot verlies van vertrouwen en verkeer.",
          technicalDetail: `SSL-validatie mislukt voor ${entry.domain}. Certificaat: ${entry.detail}. Browser toont 'Verbinding is niet privé' (ERR_CERT_DATE_INVALID of gelijkwaardig).`,
          prevention: "Gebruik Let's Encrypt met auto-verlenging via Certbot of hosting-paneel. Stel een kalender-herinnering in 30 dagen voor vervaldatum. Monitor SSL via cron-job.",
          actionUrl: `https://www.ssllabs.com/ssltest/analyze.html?d=${entry.domain}`,
        };
      }
      return {
        rootCause: "Het SSL-certificaat verloopt binnenkort. Als het niet op tijd wordt verlengd, worden bezoekers geblokkeerd door hun browser.",
        technicalDetail: `Certificaat voor ${entry.domain} verloopt over ${entry.detail}. Auto-verlenging is mogelijk niet geconfigureerd of mislukt.`,
        prevention: "Controleer of auto-verlenging actief is (certbot renew --dry-run). Voeg een extra e-mailmelding toe bij de CA (Let's Encrypt stuurt 30/14/7 dagen van te voren een mail).",
        actionUrl: `https://${entry.domain}/wp-admin`,
      };

    case "tls":
      return {
        rootCause: "TLS (Transport Layer Security) handshake faalt voor de monitor. Dit betekent meestal dat de server geen complete certificaatketen (intermediate CA) meestuurt, of dat er een certificaat/hostname mismatch is.",
        technicalDetail: `TLS-validatie mislukt voor ${entry.domain}. Detail: ${entry.detail}. De monitor ziet vaak UNABLE_TO_VERIFY_LEAF_SIGNATURE of 'unable to verify the first certificate'.`,
        prevention: "Laat de hosting-provider de volledige certificate chain (fullchain) installeren. Test met SSL Labs en controleer of intermediate certificaten meegestuurd worden. Vermijd handmatig geplaatste certificaten zonder fullchain.",
        actionUrl: `https://www.ssllabs.com/ssltest/analyze.html?d=${entry.domain}`,
      };

    case "offline_event":
      return {
        rootCause: "De site is recentelijk offline geweest. Dit kan wijzen op instabiele hosting, piek-belasting, of geplande onderhoud zonder melding.",
        technicalDetail: `Offline-log voor ${entry.domain} bevat ${entry.detail}. Elk event is gelogd met timestamp en HTTP-statuscode op het moment van de fout.`,
        prevention: "Bekijk de offline-log voor patroon (tijdstip, frequentie). Overweeg een CDN (Cloudflare) om downtime op te vangen. Vraag de hosting-provider naar de SLA en uptime-garantie.",
        actionUrl: `https://${entry.domain}/wp-admin`,
      };

    case "update":
      return {
        rootCause: "Beschikbare updates zijn niet geïnstalleerd. Verouderde plugins en themes vormen het grootste veiligheidsrisico voor WordPress-sites.",
        technicalDetail: `${entry.domain} heeft openstaande updates: ${entry.detail}. Elke dag zonder update vergroot de kans op een beveiligingslek dat actief misbruikt wordt.`,
        prevention: "Schakel auto-updates in voor kleine versies. Gebruik een staging-omgeving om grote updates te testen. Plan maandelijks een update-sessie.",
        actionUrl: `https://${entry.domain}/wp-admin/update-core.php`,
      };
  }
}

// ─── Storage helpers ───────────────────────────────────────────────────────────

function loadLog(): AlertLogEntry[] {
  try {
    const raw = typeof window !== "undefined" ? localStorage.getItem(LOG_KEY) : null;
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLog(entries: AlertLogEntry[]) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(0, MAX_LOG_ENTRIES)));
  } catch {
    // localStorage vol — niet kritiek
  }
}

// ─── Severity config ───────────────────────────────────────────────────────────

const severityConfig = {
  critical: { label: "Kritiek",   dot: "bg-red-400",    badge: "bg-red-500/10 border-red-500/20 text-red-400",    row: "border-l-2 border-l-red-500/40" },
  warning:  { label: "Waarschuwing", dot: "bg-yellow-400", badge: "bg-yellow-500/10 border-yellow-500/20 text-yellow-400", row: "border-l-2 border-l-yellow-500/40" },
  info:     { label: "Info",      dot: "bg-blue-400",   badge: "bg-blue-500/10 border-blue-500/20 text-blue-400",  row: "border-l-2 border-l-blue-500/20" },
};

const categoryLabel: Record<AlertCategory, string> = {
  offline:       "Offline",
  http:          "HTTP fout",
  ssl:           "SSL",
  tls:           "TLS",
  offline_event: "Offline event",
  update:        "Update",
};

// ─── Format helpers ────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s geleden`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m geleden`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}u geleden`;
  return `${Math.floor(h / 24)}d geleden`;
}

// ─── Hook: useAlertLog ─────────────────────────────────────────────────────────

export function useAlertLog() {
  const [log, setLog] = useState<AlertLogEntry[]>([]);
  const initialized = useRef(false);

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      setLog(loadLog());
    }
  }, []);

  function addEntry(base: Omit<AlertLogEntry, "id" | "timestamp" | "rootCause" | "technicalDetail" | "prevention" | "actionUrl">) {
    const analysis = analyzeRootCause(base);
    const entry: AlertLogEntry = {
      ...base,
      ...analysis,
      id: `${base.siteId}-${base.category}-${Date.now()}`,
      timestamp: Date.now(),
    };
    setLog((prev) => {
      const next = [entry, ...prev].slice(0, MAX_LOG_ENTRIES);
      saveLog(next);
      return next;
    });
  }

  function resolveEntry(id: string) {
    setLog((prev) => {
      const next = prev.map((e) => e.id === id ? { ...e, resolvedAt: Date.now() } : e);
      saveLog(next);
      return next;
    });
  }

  function clearLog() {
    setLog([]);
    saveLog([]);
  }

  return { log, addEntry, resolveEntry, clearLog };
}

// ─── AlertLog Panel Component ──────────────────────────────────────────────────

interface AlertLogPanelProps {
  log: AlertLogEntry[];
  onResolve: (id: string) => void;
  onClear: () => void;
}

type FilterSeverity = "all" | AlertSeverity;
type FilterCategory = "all" | AlertCategory;

export function AlertLogPanel({ log, onResolve, onClear }: AlertLogPanelProps) {
  const [expandedId, setExpandedId]     = useState<string | null>(null);
  const [filterSeverity, setFilterSeverity] = useState<FilterSeverity>("all");
  const [filterCategory, setFilterCategory] = useState<FilterCategory>("all");
  const [showResolved, setShowResolved] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const filtered = useMemo(() => {
    return log.filter((e) => {
      if (!showResolved && e.resolvedAt) return false;
      if (filterSeverity !== "all" && e.severity !== filterSeverity) return false;
      if (filterCategory !== "all" && e.category !== filterCategory) return false;
      return true;
    });
  }, [log, filterSeverity, filterCategory, showResolved]);

  const unresolved = log.filter((e) => !e.resolvedAt).length;
  const now = Date.now();

  return (
    <div className="flex flex-col bg-neutral-950/60 border border-white/5 rounded-[2rem] overflow-hidden">

      {/* Header */}
      <div className="flex items-center justify-between px-8 py-6 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className={`w-2 h-2 rounded-full ${unresolved > 0 ? "bg-red-400 animate-pulse" : "bg-[#20d67b]"}`} />
          <h3 className="text-sm font-black uppercase tracking-widest text-neutral-200">Alert Log</h3>
          {unresolved > 0 && (
            <span className="w-5 h-5 rounded-full bg-red-500 text-white text-[9px] font-black flex items-center justify-center">{unresolved}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowResolved((v) => !v)}
            className={`px-3 py-1.5 rounded-xl border text-[10px] font-mono uppercase tracking-wider transition-all ${showResolved ? "bg-[#20d67b]/10 border-[#20d67b]/20 text-[#20d67b]" : "bg-white/5 border-white/10 text-neutral-500 hover:text-white"}`}
          >
            {showResolved ? "Verberg opgelost" : "Toon opgelost"}
          </button>
          {confirmClear ? (
            <div className="flex items-center gap-2">
              <button onClick={() => setConfirmClear(false)} className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-neutral-400 text-[10px] font-black uppercase tracking-wider hover:text-white transition-all">Annuleer</button>
              <button onClick={() => { onClear(); setConfirmClear(false); }} className="px-3 py-1.5 rounded-xl bg-red-500/20 border border-red-500/30 text-red-400 text-[10px] font-black uppercase tracking-wider hover:bg-red-500/30 transition-all">Verwijder alles</button>
            </div>
          ) : (
            <button onClick={() => setConfirmClear(true)} className="px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 text-neutral-500 text-[10px] font-mono uppercase tracking-wider hover:text-white transition-all">
              Clear log
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 px-8 py-4 border-b border-white/5 bg-black/20">
        {/* Severity */}
        <div className="flex items-center gap-1.5">
          {(["all", "critical", "warning", "info"] as FilterSeverity[]).map((s) => (
            <button
              key={s}
              onClick={() => setFilterSeverity(s)}
              className={`px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-all ${
                filterSeverity === s
                  ? s === "all" ? "bg-white/10 border-white/20 text-white"
                    : s === "critical" ? "bg-red-500/20 border-red-500/30 text-red-400"
                    : s === "warning" ? "bg-yellow-500/20 border-yellow-500/30 text-yellow-400"
                    : "bg-blue-500/20 border-blue-500/30 text-blue-400"
                  : "bg-white/5 border-white/5 text-neutral-600 hover:text-neutral-400 hover:border-white/10"
              }`}
            >
              {s === "all" ? "Alles" : s === "critical" ? "Kritiek" : s === "warning" ? "Waarschuwing" : "Info"}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-white/10 self-center" />

        {/* Category */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {(["all", "offline", "http", "ssl", "tls", "offline_event", "update"] as FilterCategory[]).map((c) => (
            <button
              key={c}
              onClick={() => setFilterCategory(c)}
              className={`px-3 py-1 rounded-xl text-[10px] font-black uppercase tracking-wider border transition-all ${
                filterCategory === c
                  ? "bg-[#20d67b]/10 border-[#20d67b]/20 text-[#20d67b]"
                  : "bg-white/5 border-white/5 text-neutral-600 hover:text-neutral-400 hover:border-white/10"
              }`}
            >
              {c === "all" ? "Alle types" : categoryLabel[c]}
            </button>
          ))}
        </div>

        <span className="ml-auto text-[10px] font-mono text-neutral-600 self-center">{filtered.length} van {log.length} entries</span>
      </div>

      {/* Log entries */}
      <div className="overflow-y-auto max-h-[600px] divide-y divide-white/[0.04]">
        {filtered.length === 0 ? (
          <div className="py-16 flex flex-col items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-[#20d67b]/10 flex items-center justify-center mb-3">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#20d67b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </div>
            <p className="text-neutral-500 text-xs font-black uppercase tracking-widest">Geen log-entries gevonden</p>
          </div>
        ) : (
          filtered.map((entry) => {
            const cfg = severityConfig[entry.severity];
            const isExpanded = expandedId === entry.id;
            const isResolved = !!entry.resolvedAt;

            return (
              <div key={entry.id} className={`transition-all ${cfg.row} ${isResolved ? "opacity-40" : ""}`}>
                {/* Row summary */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  className="w-full flex items-start gap-4 px-8 py-4 hover:bg-white/[0.02] transition-colors text-left"
                >
                  {/* Dot + severity */}
                  <div className="flex items-center gap-2 mt-0.5 shrink-0">
                    <div className={`w-2 h-2 rounded-full ${cfg.dot} ${entry.severity === "critical" && !isResolved ? "animate-pulse" : ""}`} />
                  </div>

                  {/* Time */}
                  <div className="shrink-0 w-28">
                    <p className="text-[10px] font-mono text-neutral-500">{formatDuration(now - entry.timestamp)}</p>
                    <p className="text-[9px] font-mono text-neutral-700 mt-0.5">{formatTime(entry.timestamp)}</p>
                  </div>

                  {/* Category badge */}
                  <div className="shrink-0">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-lg border text-[9px] font-black uppercase tracking-wider ${cfg.badge}`}>
                      {categoryLabel[entry.category]}
                    </span>
                  </div>

                  {/* Site + label */}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-black text-white truncate">{entry.siteName}</p>
                    <p className="text-[10px] font-mono text-neutral-500 truncate">{entry.label} — {entry.detail}</p>
                  </div>

                  {/* Status / resolved */}
                  <div className="shrink-0 flex items-center gap-2">
                    {isResolved && (
                      <span className="text-[9px] font-mono text-[#20d67b] bg-[#20d67b]/10 border border-[#20d67b]/20 px-2 py-0.5 rounded-lg">
                        Opgelost
                      </span>
                    )}
                    <svg
                      width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                      strokeLinecap="round" strokeLinejoin="round"
                      className={`text-neutral-600 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </button>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="px-8 pb-6 space-y-4 bg-black/20">

                    {/* Root cause */}
                    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        <span className="text-[10px] font-black uppercase tracking-widest text-red-400">Oorzaak</span>
                      </div>
                      <p className="text-xs text-neutral-300 leading-relaxed">{entry.rootCause}</p>
                    </div>

                    {/* Technical detail */}
                    <div className="rounded-2xl border border-white/5 bg-black/30 p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                        <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400">Technische details</span>
                      </div>
                      <p className="text-[11px] font-mono text-neutral-500 leading-relaxed">{entry.technicalDetail}</p>
                    </div>

                    {/* Prevention */}
                    <div className="rounded-2xl border border-[#20d67b]/10 bg-[#20d67b]/[0.04] p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#20d67b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        <span className="text-[10px] font-black uppercase tracking-widest text-[#20d67b]">Hoe te voorkomen</span>
                      </div>
                      <p className="text-xs text-neutral-300 leading-relaxed">{entry.prevention}</p>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-3 pt-1">
                      <a
                        href={entry.actionUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-neutral-300 text-[10px] font-black uppercase tracking-wider hover:border-white/20 hover:text-white transition-all"
                      >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        Bekijk {entry.domain}
                      </a>
                      {!isResolved && (
                        <button
                          onClick={(e) => { e.stopPropagation(); onResolve(entry.id); }}
                          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#20d67b]/10 border border-[#20d67b]/20 text-[#20d67b] text-[10px] font-black uppercase tracking-wider hover:bg-[#20d67b]/20 transition-all"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          Markeer als opgelost
                        </button>
                      )}
                      {isResolved && entry.resolvedAt && (
                        <span className="text-[10px] font-mono text-neutral-600">Opgelost op {formatTime(entry.resolvedAt)}</span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Stats footer */}
      <div className="flex items-center gap-6 px-8 py-4 border-t border-white/5 bg-black/20">
        {(["critical", "warning", "info"] as AlertSeverity[]).map((s) => {
          const count = log.filter((e) => e.severity === s && !e.resolvedAt).length;
          const cfg = severityConfig[s];
          return (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              <span className="text-[10px] font-mono text-neutral-600">{cfg.label}: <span className="text-neutral-400 font-black">{count}</span></span>
            </div>
          );
        })}
        <div className="ml-auto text-[10px] font-mono text-neutral-700">
          {log.filter((e) => e.resolvedAt).length} opgelost / {log.length} totaal
        </div>
      </div>
    </div>
  );
}

// ─── Integration helper: sync alerts → log ────────────────────────────────────

/**
 * Roep deze functie aan vanuit SmartWpWidget telkens als `criticalAlerts` verandert.
 * Het vergelijkt de nieuwe alerts met de bestaande log en voegt alleen nieuwe toe.
 *
 * Voorbeeld gebruik in SmartWpWidget:
 *
 * import { useAlertLog, AlertLogPanel, syncAlertsToLog } from "./AlertLog";
 *
 * const { log, addEntry, resolveEntry, clearLog } = useAlertLog();
 *
 * useEffect(() => {
 *   syncAlertsToLog(criticalAlerts, log, addEntry);
 * }, [criticalAlerts]);
 */
export function syncAlertsToLog(
  currentAlerts: Array<{
    siteId: string;
    siteName: string;
    domain: string;
    type: AlertCategory;
    label: string;
    detail: string;
  }>,
  existingLog: AlertLogEntry[],
  addEntry: (entry: Omit<AlertLogEntry, "id" | "timestamp" | "rootCause" | "technicalDetail" | "prevention" | "actionUrl">) => void,
) {
  const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minuten — geen duplicaten binnen 5 min
  const now = Date.now();

  for (const alert of currentAlerts) {
    // Check of er al een recente entry is voor dezelfde site + category
    const recent = existingLog.find(
      (e) =>
        e.siteId === alert.siteId &&
        e.category === alert.type &&
        now - e.timestamp < DEDUP_WINDOW_MS
    );
    if (recent) continue;

    // Bepaal severity op basis van type
    const severity: AlertSeverity =
      alert.type === "offline" || alert.type === "http"
        ? "critical"
        : alert.type === "ssl" && alert.detail.toLowerCase().includes("fout")
        ? "critical"
        : alert.type === "tls"
        ? "warning"
        : alert.type === "ssl"
        ? "warning"
        : "info";

    addEntry({
      siteId: alert.siteId,
      siteName: alert.siteName,
      domain: alert.domain,
      category: alert.type,
      severity,
      label: alert.label,
      detail: alert.detail,
    });
  }
}
