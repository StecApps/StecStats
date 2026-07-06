import { useEffect } from "react";
import { useGetBillingStatus, useCreateCheckoutSession, useCreateBillingPortalSession } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, Crown, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSearch } from "wouter";

const FREE_FEATURES = [
  "1 player",
  "Current season stats",
  "Basic box scores",
];

const PRO_FEATURES = [
  "Unlimited players & seasons",
  "Full career dashboard",
  "Shooting gauges & advanced stats",
  "Live streaming",
  "Saved game video",
  "Shareable player profile",
];

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function Billing() {
  const { toast } = useToast();
  const search = useSearch();
  const { data: status, isLoading } = useGetBillingStatus();
  const checkout = useCreateCheckoutSession();
  const portal = useCreateBillingPortalSession();

  useEffect(() => {
    const params = new URLSearchParams(search);
    const checkoutResult = params.get("checkout");
    if (checkoutResult === "success") {
      toast({ title: "Welcome to Pro!", description: "Your subscription is being activated. This may take a few seconds." });
    } else if (checkoutResult === "cancel") {
      toast({ title: "Checkout canceled", description: "No changes were made to your plan." });
    }
  }, [search, toast]);

  const handleUpgrade = async (interval: "month" | "year") => {
    try {
      const res = await checkout.mutateAsync({ data: { interval } });
      window.location.href = res.url;
    } catch {
      toast({ title: "Error", description: "Failed to start checkout. Please try again.", variant: "destructive" });
    }
  };

  const handleManageBilling = async () => {
    try {
      const res = await portal.mutateAsync();
      window.location.href = res.url;
    } catch {
      toast({ title: "Error", description: "Failed to open billing portal. Please try again.", variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const isPro = status?.plan === "pro";
  const isTrialing = status?.status === "trialing";
  const trialEnd = formatDate(status?.trialEnd);
  const periodEnd = formatDate(status?.currentPeriodEnd);

  return (
    <div className="flex flex-col space-y-6 max-w-4xl mx-auto w-full">
      <div>
        <h1 className="text-4xl font-display font-bold uppercase tracking-tight text-secondary">Billing</h1>
        <p className="text-muted-foreground">Manage your plan and subscription.</p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              {isPro ? <Crown className="w-5 h-5 text-primary" /> : null}
              <CardTitle className="font-display text-2xl uppercase tracking-wide">
                {isPro ? "Pro Plan" : "Free Plan"}
              </CardTitle>
              <Badge variant={isPro ? "default" : "secondary"} data-testid="badge-current-plan">
                {isPro ? "Active" : "Current"}
              </Badge>
            </div>
          </div>
          <CardDescription>
            {isPro && isTrialing && trialEnd
              ? `You're in your free trial. It ends on ${trialEnd}.`
              : isPro && status?.cancelAtPeriodEnd && periodEnd
                ? `Your subscription will end on ${periodEnd}.`
                : isPro && periodEnd
                  ? `Your subscription renews on ${periodEnd}.`
                  : "You're on the Free plan. Upgrade to unlock the full app."}
          </CardDescription>
        </CardHeader>
        {isPro && (
          <CardContent>
            <Button variant="outline" onClick={handleManageBilling} disabled={portal.isPending} data-testid="button-manage-billing">
              {portal.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Manage subscription
            </Button>
          </CardContent>
        )}
      </Card>

      {!isPro && (
        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-xl uppercase tracking-wide text-muted-foreground">Free</CardTitle>
              <CardDescription>$0 / month</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="space-y-2">
                {FREE_FEATURES.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Check className="w-4 h-4 text-muted-foreground/70 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          <Card className="border-primary/50 shadow-md">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                <CardTitle className="font-display text-xl uppercase tracking-wide">Pro</CardTitle>
              </div>
              <CardDescription>14-day free trial, then $6.99/mo or $59/yr</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {PRO_FEATURES.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-primary shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="flex flex-col sm:flex-row gap-2 pt-2">
                <Button
                  className="flex-1 font-display uppercase tracking-wide"
                  onClick={() => handleUpgrade("month")}
                  disabled={checkout.isPending}
                  data-testid="button-upgrade-monthly"
                >
                  {checkout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Start trial — Monthly
                </Button>
                <Button
                  variant="secondary"
                  className="flex-1 font-display uppercase tracking-wide"
                  onClick={() => handleUpgrade("year")}
                  disabled={checkout.isPending}
                  data-testid="button-upgrade-yearly"
                >
                  {checkout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                  Start trial — Yearly
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
