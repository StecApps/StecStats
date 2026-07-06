import { Link } from "wouter";
import { Trophy, Radio, BarChart3 } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center px-4 text-center gap-8">
      <div className="flex flex-col items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-primary text-primary-foreground flex items-center justify-center font-display text-5xl leading-none">
          S
        </div>
        <div className="flex flex-col leading-none gap-1">
          <span className="font-display text-5xl font-bold leading-none">STEC STATS</span>
          <span className="text-xs font-medium uppercase tracking-widest text-primary/80 leading-none">
            Your all-in-one basketball stats app
          </span>
        </div>
      </div>

      <p className="max-w-md text-muted-foreground">
        Track rosters, record live box scores, and stream games to family and
        fans — all in one private team dashboard.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl w-full text-left">
        <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
          <Trophy className="w-5 h-5 text-primary" />
          <p className="text-sm font-medium">Rosters & stats</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          <p className="text-sm font-medium">Live box scores</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
          <Radio className="w-5 h-5 text-primary" />
          <p className="text-sm font-medium">Invite-link streaming</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Link
          href="/sign-in"
          className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-6 py-2.5 text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          Sign In
        </Link>
        <Link
          href="/sign-up"
          className="inline-flex items-center justify-center rounded-md border border-border bg-card px-6 py-2.5 text-sm font-semibold hover:bg-accent transition-colors"
        >
          Sign Up
        </Link>
      </div>
    </div>
  );
}
