import { Link } from "wouter";
import { Show } from "@clerk/react";

export default function MarketingHeader() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 max-w-screen-xl items-center justify-between mx-auto px-4 md:px-8">
        <Link href="/" className="flex items-center space-x-2">
          <img src="/logo.png" alt="StecStats" className="w-10 h-10 rounded object-contain" />
          <span className="hidden sm:block text-[9px] font-medium uppercase tracking-widest text-primary/80 leading-none">
            Your all-in-one basketball app
          </span>
        </Link>

        <nav className="flex items-center gap-2 sm:gap-4">
          <Link
            href="/pricing"
            className="text-sm font-medium text-foreground/70 hover:text-foreground transition-colors px-2 py-1.5"
          >
            Pricing
          </Link>

          <Show when="signed-in">
            <Link
              href="/dashboard"
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              Go to Dashboard
            </Link>
          </Show>

          <Show when="signed-out">
            <Link
              href="/sign-in"
              className="text-sm font-medium text-foreground/70 hover:text-foreground transition-colors px-2 py-1.5"
            >
              Sign In
            </Link>
            <Link
              href="/sign-up"
              className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-semibold hover:bg-primary/90 transition-colors"
            >
              Get Started
            </Link>
          </Show>
        </nav>
      </div>
    </header>
  );
}
