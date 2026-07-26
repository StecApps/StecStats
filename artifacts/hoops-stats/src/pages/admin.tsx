import { useEffect, useState } from "react";
import { useUser } from "@clerk/react";
import { Loader2, CheckCircle2, Clock, Mail, User, CreditCard } from "lucide-react";
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

export default function AdminFeedback() {
  const { isLoaded } = useUser();
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [purchases, setPurchases] = useState<PurchaseEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const [feedbackRes, purchasesRes] = await Promise.all([
        fetch("/api/admin/feedback"),
        fetch("/api/admin/purchase-events"),
      ]);
      if (feedbackRes.status === 403) { setForbidden(true); return; }
      setRows(await feedbackRes.json());
      if (purchasesRes.ok) setPurchases(await purchasesRes.json());
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
