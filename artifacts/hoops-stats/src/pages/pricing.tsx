import { useState } from "react";
import { useLocation } from "wouter";
import { useUser } from "@clerk/react";
import { useCreateCheckoutSession } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Check, Sparkles, Loader2 } from "lucide-react";
import MarketingHeader from "@/components/marketing-header";
import { useToast } from "@/hooks/use-toast";

export const PENDING_CHECKOUT_KEY = "stec-pending-checkout-interval";
export const FAILED_CHECKOUT_KEY = "stec-failed-checkout-interval";

const FREE_FEATURES = [
  "1 player",
  "Current season stats",
  "Basic box scores",
];

const PRO_FEATURES = [
  "Unlimited players & seasons",
  "Full career dashboard",
  "Shooting gauges & advanced stats",
  "Live streaming to family & fans",
  "Saved game video & highlight reels",
  "Shareable player profile",
];

export default function Pricing() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { isSignedIn, isLoaded } = useUser();
  const [interval, setInterval] = useState<"month" | "year">("month");
  const checkout = useCreateCheckoutSession();

  const handleStartTrial = async () => {
    if (!isLoaded) return;

    if (!isSignedIn) {
      sessionStorage.setItem(PENDING_CHECKOUT_KEY, interval);
      setLocation("/sign-up");
      return;
    }

    try {
      const res = await checkout.mutateAsync({ data: { interval } });
      window.location.href = res.url;
    } catch {
      toast({ title: "Error", description: "Failed to start checkout. Please try again.", variant: "destructive" });
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col">
      <MarketingHeader />

      <main className="flex-1 flex flex-col items-center px-4 py-14 md:py-20 gap-12">
        <div className="text-center max-w-xl space-y-3">
          <p className="text-xs font-bold uppercase tracking-[0.3em] text-primary">Simple, honest pricing</p>
          <h1 className="text-4xl md:text-5xl font-display font-bold uppercase tracking-tight text-secondary">
            Pick your plan
          </h1>
          <p className="text-muted-foreground">
            Start free. Upgrade to Pro whenever you want the full career picture, live streaming, and highlight reels.
          </p>
        </div>

        <Tabs value={interval} onValueChange={(v) => setInterval(v as "month" | "year")}>
          <TabsList>
            <TabsTrigger value="month" data-testid="tab-monthly">Monthly</TabsTrigger>
            <TabsTrigger value="year" data-testid="tab-annual">Annual — save ~30%</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid md:grid-cols-2 gap-6 max-w-3xl w-full">
          <Card>
            <CardHeader>
              <CardTitle className="font-display text-2xl uppercase tracking-wide text-muted-foreground">Free</CardTitle>
              <CardDescription className="text-3xl font-display font-bold text-foreground pt-2">$0<span className="text-sm font-sans font-normal text-muted-foreground"> / forever</span></CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2">
                {FREE_FEATURES.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Check className="w-4 h-4 text-muted-foreground/70 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                className="w-full font-display uppercase tracking-wide"
                onClick={() => setLocation(isSignedIn ? "/dashboard" : "/sign-up")}
                data-testid="button-start-free"
              >
                {isSignedIn ? "Go to Dashboard" : "Start Free"}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-primary/50 shadow-md relative overflow-hidden">
            <div className="absolute top-0 right-0 bg-primary text-primary-foreground text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-bl-lg">
              14-day free trial
            </div>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                <CardTitle className="font-display text-2xl uppercase tracking-wide">Pro</CardTitle>
              </div>
              <CardDescription className="text-3xl font-display font-bold text-foreground pt-2">
                {interval === "month" ? (
                  <>$6.99<span className="text-sm font-sans font-normal text-muted-foreground"> / month</span></>
                ) : (
                  <>$59<span className="text-sm font-sans font-normal text-muted-foreground"> / year</span></>
                )}
              </CardDescription>
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
              <Button
                className="w-full font-display uppercase tracking-wide"
                onClick={handleStartTrial}
                disabled={checkout.isPending || !isLoaded}
                data-testid="button-start-trial"
              >
                {checkout.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Start Free Trial
              </Button>
            </CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground max-w-md text-center">
          No credit card surprises — cancel anytime from your billing page. Prices in USD.
        </p>
      </main>
    </div>
  );
}
