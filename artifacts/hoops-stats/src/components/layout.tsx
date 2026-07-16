import { Link, useLocation } from "wouter";
import { Trophy, FileUp, Activity, LogOut, Crown, CreditCard, Sparkles, Zap } from "lucide-react";
import { useUser, useClerk } from "@clerk/react";
import { useGetBillingStatus } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function PlanBadge() {
  const { data: status } = useGetBillingStatus();
  const isPro = status?.plan === "pro";
  const isPremium = status?.plan === "premium";

  return (
    <Link href="/billing">
      <Badge
        data-testid="badge-plan-status"
        variant={(isPro || isPremium) ? "default" : "secondary"}
        className="cursor-pointer flex items-center gap-1"
      >
        {isPremium ? <Zap className="w-3 h-3" /> : isPro ? <Crown className="w-3 h-3" /> : null}
        {isPremium ? "Premium" : isPro ? "Pro" : "Free"}
      </Badge>
    </Link>
  );
}

function UserMenu() {
  const { user, isLoaded } = useUser();
  const { signOut } = useClerk();

  if (!isLoaded || !user) return null;

  const label = user.primaryEmailAddress?.emailAddress ?? user.username ?? "Account";

  return (
    <div className="flex items-center gap-3">
      <PlanBadge />
      <span
        data-testid="user-email-display"
        className="hidden sm:inline text-xs text-foreground/60 truncate max-w-[160px]"
      >
        {label}
      </span>
      <button
        type="button"
        onClick={() => signOut({ redirectUrl: basePath || "/" })}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground/70 hover:text-foreground hover:bg-accent transition-colors"
      >
        <LogOut className="w-3.5 h-3.5" />
        Log out
      </button>
    </div>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/dashboard", label: "Dashboard", icon: Trophy },
    { href: "/record", label: "Record Game", icon: Activity },
    { href: "/import", label: "Import", icon: FileUp },
    { href: "/billing", label: "Billing", icon: CreditCard },
    { href: "/pricing", label: "Pricing", icon: Sparkles },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col w-full">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-24 max-w-screen-2xl items-center mx-auto px-4 md:px-8">
          <div className="mr-4 hidden md:flex flex-1 items-center justify-between">
            <div className="flex items-center">
              <Link href="/dashboard" className="mr-6 flex items-center gap-3">
                <img src="/logo.png" alt="StecStats" className="h-16 w-auto object-contain flex-shrink-0 drop-shadow-[0_0_12px_rgba(249,115,22,0.5)]" />
                <span className="hidden lg:block text-xs font-medium uppercase tracking-widest text-primary/70 leading-none">Your all-in-one app</span>
              </Link>
              <nav className="flex items-center space-x-6 text-sm font-medium">
                {navItems.map((item) => {
                  const isActive = location === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "transition-colors hover:text-foreground/80 flex items-center gap-2",
                        isActive ? "text-foreground font-bold" : "text-foreground/60"
                      )}
                    >
                      <item.icon className="w-4 h-4" />
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            </div>
            <UserMenu />
          </div>
          {/* Mobile nav */}
          <div className="md:hidden flex w-full justify-between items-center">
            <Link href="/dashboard" className="flex items-center gap-3">
              <img src="/logo.png" alt="StecStats" className="h-14 w-auto object-contain flex-shrink-0 drop-shadow-[0_0_12px_rgba(249,115,22,0.5)]" />
              <span className="text-xs font-medium uppercase tracking-widest text-primary/70 leading-none">Your all-in-one app</span>
            </Link>
            <UserMenu />
          </div>
        </div>
      </header>
      <main className="flex-1 flex flex-col container max-w-screen-2xl mx-auto px-4 md:px-8 py-6">
        {children}
      </main>
      
      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 border-t border-border bg-background z-50" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
        <nav className="flex h-16 items-center justify-around px-6">
          {navItems.map((item) => {
            const isActive = location === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 w-full h-full",
                  isActive ? "text-primary" : "text-muted-foreground"
                )}
              >
                <item.icon className="w-5 h-5" />
                <span className="text-[10px] font-medium">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
