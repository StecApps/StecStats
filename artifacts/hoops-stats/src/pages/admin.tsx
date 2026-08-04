import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { Loader2, CheckCircle2, Clock, Mail, User, CreditCard, Webhook, AlertTriangle, RefreshCw, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import MarketingHeader from "@/components/marketing-header";

type FeedbackRow = {
  id: number;
  userId: number | null;
  name: string | null;
  email: string | null;
  message: string;
  createdAt: string;
  status: string;
};

type PurchaseEvent = {
  id: number;
  userId: number | null;
  email: string | null;
  plan: string;
  interval: string | null;
  createdAt: string;
};

type ManagedWebhook = {
  id: string;
  url: string;
  enabled: boolean;
  status: string | null;
  created: number | null;
  last_synced_at: string | null;
};

type SyncStatusRow = {
  resource: string;
  status: string | null;
  last_synced_at: string | null;
  last_incremental_cursor: string | null;
  error_message: string | null;
  updated_at: string | null;
};

type StripeSyncHealth = {
  newestSubscriptionAt: string | null;
  newestCustomerAt: string | null;
  managedWebhooks: ManagedWebhook[];
  syncStatus: SyncStatusRow[];
};

export default function AdminFeedback() {
  const { isLoaded } = useUser();
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [purchases, setPurchases] = useState<PurchaseEvent[]>([]);
  const [stripeSyncHealth, setStripeSyncHealth] = useState<StripeSyncHealth | null>(null);
  const [stripeSyncError, setStripeSyncError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [feedbackRes, purchasesRes, syncStatusRes] = await Promise.all([
        fetch("/api/admin/feedback"),
        fetch("/api/admin/purchase-events"),
        fetch("/api/admin/stripe/sync-status"),
      ]);
      if (feedbackRes.status === 403) { setForbidden(true); return; }
      setRows(await feedbackRes.json());
      if (purchasesRes.ok) setPurchases(await purchasesRes.json());
      if (syncStatusRes.ok) {
        setStripeSyncHealth(await syncStatusRes.json());
      } else {
        const body = await syncStatusRes.json().catch(() => ({}));
        setStripeSyncError((body as { error?: string }).error ?? "Failed to load sync status");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (isLoaded) load(); }, [isLoaded]);

  async function markReviewed(id: number) {
    await fetch(`/api/admin/feedback/${id}`, { method: "PATCH" });
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, status: "reviewed" } : r));
  }

  if (!isLoaded || loading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <p className="text-muted-foreground">Access denied.</p>
      </div>
    );
  }

  const newRows = rows.filter((r) => r.status === "new");
  const reviewedRows = rows.filter((r) => r.status === "reviewed");

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <MarketingHeader />
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-10 space-y-12">

        {/* Stripe Sync Health */}
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-3xl font-display font-bold uppercase tracking-tight text-foreground">
                Stripe Sync
              </h2>
              <p className="text-muted-foreground mt-1">Billing data freshness &amp; webhook health</p>
            </div>
            <Button size="sm" variant="outline" onClick={load} className="shrink-0">
              <RefreshCw className="w-3 h-3 mr-1" />
              Refresh
            </Button>
          </div>

          {stripeSyncError && (
            <div className="rounded-xl border border-red-700/40 bg-red-950/20 p-4 flex items-center gap-3 text-sm text-red-400">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              {stripeSyncError}
            </div>
          )}

          {stripeSyncHealth && (
            <div className="space-y-3">
              {/* Newest record timestamps */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5" />
                  Data Freshness
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Newest Subscription</p>
                    <p className="text-sm text-foreground">
                      {stripeSyncHealth.newestSubscriptionAt
                        ? new Date(stripeSyncHealth.newestSubscriptionAt).toLocaleString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                            hour: "numeric", minute: "2-digit",
                          })
                        : <span className="text-muted-foreground italic">none</span>}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-1">Newest Customer</p>
                    <p className="text-sm text-foreground">
                      {stripeSyncHealth.newestCustomerAt
                        ? new Date(stripeSyncHealth.newestCustomerAt).toLocaleString("en-US", {
                            month: "short", day: "numeric", year: "numeric",
                            hour: "numeric", minute: "2-digit",
                          })
                        : <span className="text-muted-foreground italic">none</span>}
                    </p>
                  </div>
                </div>
              </div>

              {/* Managed webhooks */}
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Webhook className="w-3.5 h-3.5" />
                  Managed Webhooks
                </p>
                {stripeSyncHealth.managedWebhooks.length === 0 ? (
                  <p className="text-sm text-muted-foreground italic">No managed webhooks registered.</p>
                ) : (
                  <div className="space-y-2">
                    {stripeSyncHealth.managedWebhooks.map((wh) => (
                      <div key={wh.id} className="flex items-start gap-3">
                        <div className={`mt-0.5 w-2 h-2 rounded-full shrink-0 ${wh.enabled ? "bg-green-400" : "bg-red-400"}`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-foreground break-all">{wh.url}</p>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <Badge
                              className={`text-[10px] uppercase tracking-wider ${
                                wh.status === "enabled" || wh.enabled
                                  ? "bg-green-700 text-white"
                                  : "bg-red-700 text-white"
                              }`}
                            >
                              {wh.status ?? (wh.enabled ? "enabled" : "disabled")}
                            </Badge>
                            {wh.last_synced_at && (
                              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                synced {new Date(wh.last_synced_at).toLocaleString("en-US", {
                                  month: "short", day: "numeric",
                                  hour: "numeric", minute: "2-digit",
                                })}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Per-resource sync status */}
              {stripeSyncHealth.syncStatus.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resource Sync Status</p>
                  <div className="space-y-1.5">
                    {stripeSyncHealth.syncStatus.map((s) => (
                      <div key={s.resource} className="flex items-center gap-3 text-xs">
                        <span className="text-muted-foreground w-36 shrink-0 truncate">{s.resource}</span>
                        <Badge
                          variant="outline"
                          className={`text-[10px] uppercase tracking-wider shrink-0 ${
                            s.status === "complete" ? "border-green-700/50 text-green-400" :
                            s.status === "running"  ? "border-yellow-700/50 text-yellow-400" :
                            s.status === "error"    ? "border-red-700/50 text-red-400" :
                            "border-border text-muted-foreground"
                          }`}
                        >
                          {s.status ?? "idle"}
                        </Badge>
                        {s.last_synced_at && (
                          <span className="text-muted-foreground truncate">
                            {new Date(s.last_synced_at).toLocaleString("en-US", {
                              month: "short", day: "numeric",
                              hour: "numeric", minute: "2-digit",
                            })}
                          </span>
                        )}
                        {s.error_message && (
                          <span className="text-red-400 truncate" title={s.error_message}>{s.error_message}</span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Purchases */}
        <section className="space-y-4">
          <div>
            <h1 className="text-3xl font-display font-bold uppercase tracking-tight text-foreground">
              Purchases
            </h1>
            <p className="text-muted-foreground mt-1">
              {purchases.length} confirmed checkout{purchases.length !== 1 ? "s" : ""}
            </p>
          </div>

          {purchases.length === 0 && (
            <p className="text-muted-foreground text-sm">No purchases yet.</p>
          )}

          <div className="space-y-3">
            {purchases.map((p) => (
              <div
                key={p.id}
                className="rounded-xl border border-green-700/40 bg-green-950/20 p-4 flex items-center gap-4"
              >
                <div className="w-9 h-9 rounded-full bg-green-700/20 flex items-center justify-center shrink-0">
                  <CreditCard className="w-4 h-4 text-green-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className="bg-green-700 text-white text-[10px] uppercase tracking-wider">
                      {p.plan}
                    </Badge>
                    {p.interval && (
                      <Badge variant="outline" className="text-[10px] text-green-400 border-green-700/50 uppercase tracking-wider">
                        {p.interval}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(p.createdAt).toLocaleString("en-US", {
                        month: "short", day: "numeric", year: "numeric",
                        hour: "numeric", minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {p.email && (
                    <a
                      href={`mailto:${p.email}`}
                      className="text-xs text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 mt-1"
                    >
                      <Mail className="w-3 h-3" />
                      {p.email}
                    </a>
                  )}
                </div>
                {p.userId && (
                  <span className="text-xs text-muted-foreground/60 shrink-0">User #{p.userId}</span>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Issue Reports */}
        <section className="space-y-4">
          <div>
            <h2 className="text-3xl font-display font-bold uppercase tracking-tight text-foreground">
              Issue Reports
            </h2>
            <p className="text-muted-foreground mt-1">
              {newRows.length} new · {reviewedRows.length} reviewed
            </p>
          </div>

          {rows.length === 0 && (
            <p className="text-muted-foreground text-sm">No reports yet.</p>
          )}

          <div className="space-y-3">
            {rows.map((row) => (
              <div
                key={row.id}
                className={`rounded-xl border p-4 space-y-3 transition-colors ${
                  row.status === "new"
                    ? "border-primary/30 bg-primary/5"
                    : "border-border bg-card opacity-60"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    {row.status === "new" ? (
                      <Badge variant="default" className="text-[10px] uppercase tracking-wider bg-primary text-primary-foreground">New</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">Reviewed</Badge>
                    )}
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(row.createdAt).toLocaleString("en-US", {
                        month: "short", day: "numeric", year: "numeric",
                        hour: "numeric", minute: "2-digit",
                      })}
                    </span>
                  </div>
                  {row.status === "new" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="shrink-0 h-7 text-xs"
                      onClick={() => markReviewed(row.id)}
                    >
                      <CheckCircle2 className="w-3 h-3 mr-1" />
                      Mark reviewed
                    </Button>
                  )}
                </div>

                <p className="text-sm text-foreground whitespace-pre-wrap">{row.message}</p>

                {(row.name || row.email) && (
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    {row.name && (
                      <span className="flex items-center gap-1">
                        <User className="w-3 h-3" />
                        {row.name}
                      </span>
                    )}
                    {row.email && (
                      <a
                        href={`mailto:${row.email}`}
                        className="flex items-center gap-1 hover:text-primary transition-colors"
                      >
                        <Mail className="w-3 h-3" />
                        {row.email}
                      </a>
                    )}
                    {row.userId && (
                      <span className="text-muted-foreground/60">User #{row.userId}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

      </main>
    </div>
  );
}
