import { Link, useLocation } from "wouter";
import { Trophy, FileUp, Activity } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  const navItems = [
    { href: "/", label: "Dashboard", icon: Trophy },
    { href: "/record", label: "Record Game", icon: Activity },
    { href: "/import", label: "Import", icon: FileUp },
  ];

  return (
    <div className="min-h-[100dvh] flex flex-col w-full">
      <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 max-w-screen-2xl items-center mx-auto px-4 md:px-8">
          <div className="mr-4 hidden md:flex">
            <Link href="/" className="mr-6 flex items-center space-x-2">
              <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-display text-2xl leading-none">
                H
              </div>
              <span className="hidden font-display text-2xl font-bold sm:inline-block leading-none mt-1">
                HOOPS STATS
              </span>
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
          {/* Mobile nav */}
          <div className="md:hidden flex w-full justify-between items-center">
            <Link href="/" className="flex items-center space-x-2">
              <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-display text-2xl leading-none">
                H
              </div>
              <span className="font-display text-2xl font-bold inline-block leading-none mt-1">
                HOOPS STATS
              </span>
            </Link>
          </div>
        </div>
      </header>
      <main className="flex-1 flex flex-col container max-w-screen-2xl mx-auto px-4 md:px-8 py-6">
        {children}
      </main>
      
      {/* Mobile bottom nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 border-t border-border bg-background z-50 pb-safe">
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
