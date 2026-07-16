import { Link } from "wouter";
import { Trophy, Radio, BarChart3, Sparkles, ArrowRight, Users, Film } from "lucide-react";
import MarketingHeader from "@/components/marketing-header";

export default function Home() {
  return (
    <div className="min-h-[100dvh] flex flex-col">
      <MarketingHeader />

      <main className="flex-1 flex flex-col items-center">
        {/* HERO */}
        <section className="w-full relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 [background:radial-gradient(ellipse_60%_60%_at_50%_0%,hsl(var(--primary)/0.18),transparent_65%)]" />
          <div className="relative max-w-4xl mx-auto px-4 py-16 md:py-24 flex flex-col items-center text-center gap-6">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/60 px-4 py-1.5 text-[0.65rem] font-bold uppercase tracking-[0.25em] text-primary">
              <Sparkles className="w-3 h-3" /> Built for youth basketball families
            </span>

            <h1 className="font-display font-bold uppercase leading-[0.95] tracking-tight text-5xl md:text-7xl text-secondary max-w-3xl">
              One athlete. Every team & season. One place.
            </h1>

            <p className="max-w-xl text-lg text-muted-foreground">
              StecStats follows your player across every travel team, school season, and tournament —
              live box scores, streaming, and highlight reels, all in one private dashboard.
            </p>

            <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
              <Link
                href="/sign-up"
                className="inline-flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground px-8 py-3 text-sm font-bold uppercase tracking-wide hover:bg-primary/90 transition-colors"
              >
                Start Free Trial <ArrowRight className="w-4 h-4" />
              </Link>
              <Link
                href="/pricing"
                className="inline-flex items-center justify-center rounded-md border border-border bg-card px-8 py-3 text-sm font-bold uppercase tracking-wide hover:bg-accent transition-colors"
              >
                See Pricing
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">No credit card required to start. Free plan available forever.</p>
          </div>
        </section>

        {/* WEDGE / VALUE PROP */}
        <section className="w-full max-w-5xl mx-auto px-4 py-10">
          <div className="grid md:grid-cols-3 gap-4">
            <div className="rounded-lg border border-border bg-card p-6 flex flex-col gap-3">
              <Trophy className="w-6 h-6 text-primary" />
              <h3 className="font-display text-xl font-bold uppercase">Rosters & career stats</h3>
              <p className="text-sm text-muted-foreground">
                Track points, rebounds, assists and more for every player — across every team they've ever played for.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6 flex flex-col gap-3">
              <BarChart3 className="w-6 h-6 text-primary" />
              <h3 className="font-display text-xl font-bold uppercase">Live box scores</h3>
              <p className="text-sm text-muted-foreground">
                Record the game from the sideline and watch the stat sheet build itself in real time.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6 flex flex-col gap-3">
              <Radio className="w-6 h-6 text-primary" />
              <h3 className="font-display text-xl font-bold uppercase">Invite-link streaming</h3>
              <p className="text-sm text-muted-foreground">
                Send grandparents and out-of-town family a private link to watch the game live — no app or account needed.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6 flex flex-col gap-3">
              <Film className="w-6 h-6 text-primary" />
              <h3 className="font-display text-xl font-bold uppercase">Highlight reels</h3>
              <p className="text-sm text-muted-foreground">
                Automatically stitch a player's best moments from a single game — or a whole season — into one shareable video.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6 flex flex-col gap-3">
              <Users className="w-6 h-6 text-primary" />
              <h3 className="font-display text-xl font-bold uppercase">One player, every team</h3>
              <p className="text-sm text-muted-foreground">
                Travel team in the spring, school team in the winter — see career totals in one dashboard, not scattered spreadsheets.
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-6 flex flex-col gap-3">
              <Sparkles className="w-6 h-6 text-primary" />
              <h3 className="font-display text-xl font-bold uppercase">Private by design</h3>
              <p className="text-sm text-muted-foreground">
                Your team's data stays yours. Nothing is public except the game links you choose to share.
              </p>
            </div>
          </div>
        </section>

        {/* CTA FOOTER */}
        <section className="w-full border-t border-border/60 bg-card/30">
          <div className="max-w-3xl mx-auto px-4 py-14 flex flex-col items-center text-center gap-4">
            <h2 className="font-display font-bold uppercase text-3xl md:text-4xl text-secondary">
              Ready to see your player's whole career in one place?
            </h2>
            <Link
              href="/sign-up"
              className="inline-flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground px-8 py-3 text-sm font-bold uppercase tracking-wide hover:bg-primary/90 transition-colors"
            >
              Get Started Free <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
