import { useEffect, useState, useCallback } from "react";
import { useGetBillingStatus, useCreateCheckoutSession, useCreateBillingPortalSession } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Check, Crown, Sparkles, Zap, X, Youtube, Link2Off, PartyPopper, ChevronRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useSearch, useLocation } from "wouter";
import { FAILED_CHECKOUT_KEY, decodeCheckoutIntent } from "@/pages/pricing";
import type { CheckoutIntent } from "@/pages/pricing";

import { FREE_FEATURES, PRO_FEATURES, PREMIUM_FEATURES } from "@workspace/plan-copy";

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function useYoutubeStatus() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(() => {
    fetch("/api/auth/youtube/status")
      .then((r) => r.json())
      .then((d: { connected: boolean }) => setConnected(d.connected))
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/auth/youtube", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
      setConnected(false);
      toast({ title: "YouTube disconnected", description: "You can reconnect any time from the Record page." });
    } catch {
      toast({ title: "Couldn't disconnect YouTube. Please try again.", variant: "destructive" });
    } finally {
      setDisconnecting(false);
    }
  }, [toast]);

  return { connected, disconnecting, disconnect };
}

export default function Billing() {
  const { toast } = useToast();
  const search = useSearch();
  const [, navigate] = useLocation();
  const { data: status, isLoading } = useGetBillingStatus();
  const checkout = useCreateCheckoutSession();
  const portal = useCreateBillingPortalSession();
  const youtube = useYoutubeStatus();

  const params = new URLSearchParams(search);
  const checkoutResult = params.get("checkout");
  const isCheckoutSuccess = checkoutResult === "success";

  const [purchaseEventFired, setPurchaseEventFired] = useState(false);

  useEffect(() => {
    if (!isCheckoutSuccess || purchaseEventFired || isLoading) return;
    const plan = status?.plan;
    if (!plan || plan === "free") return;
    setPurchaseEventFired(true);
    fetch("/api/purchase-events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan, interval: null }),
    }).catch(() => {});
  }, [isCheckoutSuccess, purchaseEventFired, isLoading, status?.plan]);

  const [resumeIntent, setResumeIntent] = useState<CheckoutIntent | null>(() => {
    try {
      return decodeCheckoutIntent(localStorage.getItem(FAILED_CHECKOUT_KEY));
    } catch {
      return null;
    }
  });

  const dismissResumeBanner = () => {
    try { localStorage.removeItem(FAILED_CHECKOUT_KEY); } catch {}
    setResumeIntent(null);
  };

  useEffect(() => {
    if (checkoutResult === "cancel") {
      toast({ title: "Checkout canceled", description: "No changes were made to your plan." });
    }
  }, [checkoutResult, toast]);

  const handleUpgrade = async (interval: "month" | "year", tier: "pro" | "premium" | "soccer" = "pro") => {
    try {
      const res = await checkout.mutateAsync({ data: { interval, tier } });
      try { localStorage.removeItem(FAILED_CHECKOUT_KEY); } catch {}
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

  const plan = status?.plan ?? "free";
  const isTrialing = status?.status === "trialing";
  const trialEnd = formatDate(status?.trialEnd);

  if (isCheckoutSuccess) {
    const isPro = plan === "pro";
    const isPremium = plan === "premium";
    const activating = !isPro && !isPremium;

    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="max-w-md w-full text-center space-y-8">
          <div className="flex justify-center">
            <div className="relative">
              <div className="w-24 h-24 rounded-full bg-primary/20 flex items-center justify-center">
                {activating
                  ? <Loader2 className="w-10 h-10 text-primary animate-spin" />
                  : <PartyPopper className="w-10 h-10 text-primary" />
                }
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-4xl font-display font-bold uppercase tracking-tight text-secondary">
              {activating ? "Activating…" : "You're in!"}
            </h1>
            <p className="text-muted-foreground text-lg">
              {activating
                ? "Your subscription is being confirmed. This only takes a moment."
                : isPremium
                  ? "Welcome to STEC STATS Premium."
                  : isTrialing && trialEnd
                    ? `Your 14-day free trial starts now. You won't be charged until ${trialEnd}.`
                    : "Welcome to STEC STATS Pro."}
            </p>
          </div>

          {!activating && (
            <div className="bg-card border border-border rounded-xl p-6 text-left space-y-3">
              <p className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                {isPremium ? "Premium" : "Pro"} features unlocked
              </p>
              <ul className="space-y-2.5">
                {(isPremium ? PREMIUM_FEATURES : PRO_FEATURES).map((f) => (
                  <li key={f} className="flex items-center gap-3 text-sm">
                    <Check className="w-4 h-4 text-primary shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {!activating && (
              <Button
                size="lg"
                className="w-full font-display uppercase tracking-wide text-base"
                onClick={() => navigate("/")}
              >
                Go to Dashboard
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => navigate("/billing")}
            >
              {activating ? "Refresh" : "View billing details"}
            </Button>
          </div>
        </div>
      </div>
    );
  }
  const isPro = plan === "pro";
  const isPremium = plan === "premium";
  const hasSoccer = status?.hasSoccer ?? false;
  const periodEnd = formatDate(status?.currentPeriodEnd);
  const planLabel = isPremium ? "Premium Plan" : isPro ? "Pro Plan" : "Free Plan";
  const planDescription = isPremium && isTrialing && trialEnd
    ? `You're in your free trial. It ends on ${trialEnd}.`
    : isPremium && status?.cancelAtPeriodEnd && periodEnd
      ? `Your Premium subscription will end on ${periodEnd}.`
      : isPremium && periodEnd
        ? `Your Premium subscription renews on ${periodEnd}.`
        : isPremium
          ? "You have an active Premium plan."
          : isPro && isTrialing && trialEnd
            ? `You're in your free trial. It ends on ${trialEnd}.`
            : isPro && status?.cancelAtPeriodEnd && periodEnd
              ? `Your subscription will end on ${periodEnd}.`
              : isPro && periodEnd
                ? `Your subscription renews on ${periodEnd}.`
                : isPro
                  ? "You have an active Pro plan."
                  : "You're on the Free plan. Upgrade to unlock the full app.";

  return (
    <div className="flex flex-col space-y-6 max-w-4xl mx-auto w-full pb-20 md:pb-0">
      <div>
        <h1 className="text-4xl font-display font-bold uppercase tracking-tight text-secondary">Billing</h1>
        <p className="text-muted-foreground">Manage your plan and subscription.</p>
      </div>

      {resumeIntent && plan === "free" && (
        <Card className="border-primary/60 bg-primary/5 shadow-md" data-testid="resume-checkout-banner">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                {resumeIntent.tier === "premium" ? <Zap className="w-5 h-5 text-primary fill-primary shrink-0" /> : <Sparkles className="w-5 h-5 text-primary shrink-0" />}
                <CardTitle className="font-display text-xl uppercase tracking-wide">Start your free trial</CardTitle>
              </div>
              <button
                onClick={dismissResumeBanner}
                className="text-muted-foreground hover:text-foreground transition-colors mt-0.5"
                aria-label="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <CardDescription>
              Your {resumeIntent.tier === "premium" ? "Premium" : "Pro"} checkout didn't complete. Resume below to start your 14-day free trial — no charge until the trial ends.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button
                className="flex-1 font-display uppercase tracking-wide"
                onClick={() => handleUpgrade("month", resumeIntent.tier)}
                disabled={checkout.isPending}
                data-testid="button-resume-monthly"
              >
                {checkout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Try {resumeIntent.tier === "premium" ? "Premium" : "Pro"} — Monthly
              </Button>
              <Button
                variant="secondary"
                className="flex-1 font-display uppercase tracking-wide"
                onClick={() => handleUpgrade("year", resumeIntent.tier)}
                disabled={checkout.isPending}
                data-testid="button-resume-yearly"
              >
                {checkout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Try {resumeIntent.tier === "premium" ? "Premium" : "Pro"} — Yearly
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              {isPremium ? <Zap className="w-5 h-5 text-primary fill-primary" /> : isPro ? <Crown className="w-5 h-5 text-primary" /> : null}
              <CardTitle className="font-display text-2xl uppercase tracking-wide">{planLabel}</CardTitle>
              <Badge variant={(isPro || isPremium) ? "default" : "secondary"} data-testid="badge-current-plan">
                {(isPro || isPremium) ? "Active" : "Current"}
              </Badge>
            </div>
          </div>
          <CardDescription>{planDescription}</CardDescription>
        </CardHeader>
        {(isPro || isPremium) && (
          <CardContent>
            <Button variant="outline" onClick={handleManageBilling} disabled={portal.isPending} data-testid="button-manage-billing">
              {portal.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Manage subscription
            </Button>
          </CardContent>
        )}
      </Card>

      {/* Connected accounts */}
      <Card>
        <CardHeader>
          <CardTitle className="font-display text-2xl uppercase tracking-wide">Connected Accounts</CardTitle>
          <CardDescription>Third-party accounts linked to your profile.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Youtube className="w-5 h-5 text-red-500" />
              <div>
                <p className="text-sm font-medium">YouTube</p>
                <p className="text-xs text-muted-foreground">
                  {youtube.connected === null
                    ? "Checking…"
                    : youtube.connected
                      ? "Connected — you can upload highlight reels directly to your channel"
                      : "Not connected"}
                </p>
              </div>
            </div>
            {youtube.connected && (
              <Button
                variant="outline"
                size="sm"
                onClick={youtube.disconnect}
                disabled={youtube.disconnecting}
                data-testid="button-disconnect-youtube"
                className="shrink-0 text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              >
                {youtube.disconnecting
                  ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  : <Link2Off className="w-3.5 h-3.5 mr-1.5" />}
                Disconnect
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Soccer add-on — shown to Pro/Premium users who don't have it yet */}
      {(isPro || isPremium) && !hasSoccer && (
        <Card className="border-green-700/40 bg-green-950/20">
          <CardHeader>
            <div className="flex items-center gap-2">
              <span className="text-xl">⚽</span>
              <CardTitle className="font-display text-xl uppercase tracking-wide">Soccer Add-on</CardTitle>
              <Badge variant="outline" className="text-green-400 border-green-600/50 text-[0.6rem]">$5/mo</Badge>
            </div>
            <CardDescription>Track goals, shots, saves, cards and more. Adds a full soccer stat sheet to every game you record.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2">
              {["Goals, assists & shots", "Saves (goalkeeper stats)", "Yellow & red cards", "Sideline quick-tap for soccer", "Works alongside your basketball teams"].map(f => (
                <li key={f} className="flex items-center gap-2 text-sm">
                  <Check className="w-4 h-4 text-green-500 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
            <Button
              className="w-full font-display uppercase tracking-wide bg-green-700 hover:bg-green-600 text-white"
              onClick={() => handleUpgrade("month", "soccer")}
              disabled={checkout.isPending}
              data-testid="button-add-soccer"
            >
              {checkout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <span className="mr-2">⚽</span>}
              Add Soccer — $5/month
            </Button>
          </CardContent>
        </Card>
      )}

      {(isPro || isPremium) && hasSoccer && (
        <Card className="border-green-700/40">
          <CardHeader>
            <div className="flex items-center gap-2">
              <span className="text-xl">⚽</span>
              <CardTitle className="font-display text-xl uppercase tracking-wide">Soccer Add-on</CardTitle>
              <Badge variant="default" className="bg-green-700 text-white">Active</Badge>
            </div>
            <CardDescription>Soccer stat tracking is enabled on your account. Manage it through your billing portal.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={handleManageBilling} disabled={portal.isPending}>
              {portal.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              Manage Soccer subscription
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Upgrade options — show when not on premium yet */}
      {!isPremium && (
        <div className="grid md:grid-cols-3 gap-6">
          {/* FREE */}
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

          {/* PRO */}
          <Card className={isPro ? "border-primary/50 shadow-md" : ""}>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                <CardTitle className="font-display text-xl uppercase tracking-wide">Pro</CardTitle>
                {isPro && <Badge variant="default">Current</Badge>}
              </div>
              <CardDescription>14-day free trial, then $9.99/mo or $79/yr</CardDescription>
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
              {!isPro && (
                <div className="flex flex-col sm:flex-row gap-2 pt-2">
                  <Button
                    className="flex-1 font-display uppercase tracking-wide"
                    onClick={() => handleUpgrade("month", "pro")}
                    disabled={checkout.isPending}
                    data-testid="button-upgrade-monthly"
                  >
                    {checkout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Monthly
                  </Button>
                  <Button
                    variant="secondary"
                    className="flex-1 font-display uppercase tracking-wide"
                    onClick={() => handleUpgrade("year", "pro")}
                    disabled={checkout.isPending}
                    data-testid="button-upgrade-yearly"
                  >
                    {checkout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                    Yearly
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* PREMIUM — coming soon */}
          <Card className="border-muted/50 opacity-80">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Zap className="w-5 h-5 text-muted-foreground" />
                <CardTitle className="font-display text-xl uppercase tracking-wide text-muted-foreground">Premium</CardTitle>
                <Badge variant="outline" className="text-muted-foreground border-muted-foreground/40 text-[0.6rem]">Coming Soon</Badge>
              </div>
              <CardDescription>Pro + Auto-Follow — +$5/mo · available soon</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {PREMIUM_FEATURES.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Check className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button
                className="w-full font-display uppercase tracking-wide"
                disabled
              >
                Coming Soon
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
