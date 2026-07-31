import { useEffect, useRef, useState, useCallback, Component, useSyncExternalStore } from "react";
import PrintCards from "./pages/print-cards";
import CardRender from "./pages/card-render";
import type { ReactNode, ErrorInfo } from "react";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { useListPlayers, useCreateCheckoutSession } from "@workspace/api-client-react";
import { Loader2, RefreshCw, CheckCircle2, AlertCircle, X } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { backgroundUpload, PENDING_VIDEO_UPLOAD_KEY, PENDING_VIDEO_UPLOADS_KEY } from "@/lib/backgroundUpload";
import { getOrderedChunks, deleteSession } from "@/lib/recordingStore";
import { uploadVideoBlob } from "@/lib/videoUpload";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Pricing, { PENDING_CHECKOUT_KEY, FAILED_CHECKOUT_KEY, encodeCheckoutIntent, decodeCheckoutIntent } from "@/pages/pricing";
import Onboarding from "@/pages/onboarding";
import Dashboard from "@/pages/dashboard";
import RecordGame from "@/pages/record";
import ImportData from "@/pages/import";
import Billing from "@/pages/billing";
import WatchStream from "@/pages/watch";
import AdminFeedback from "@/pages/admin";
import Layout from "@/components/layout";
import FeedbackButton from "@/components/feedback-button";

const queryClient = new QueryClient();

// Shared logo mark used by all full-screen fallback screens
function LogoMark() {
  return (
    <img
      src="/logo.png"
      alt="StecStats"
      style={{ height: 52, width: "auto", objectFit: "contain" }}
    />
  );
}

// Shown while we're doing the initial connectivity check
function AppLoadingScreen() {
  return (
    <div style={{
      minHeight: "100dvh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      background: "hsl(20,12%,7%)", gap: 16,
    }}>
      <LogoMark />
      <Loader2 style={{ width: 24, height: 24, color: "hsl(15,100%,55%)", animation: "spin 1s linear infinite" }} />
    </div>
  );
}

// Shown when the API is unreachable — gate screen (server not ready yet)
function ServerWaitScreen({ onRetry }: { onRetry: () => void }) {
  return (
    <div style={{
      minHeight: "100dvh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      background: "hsl(20,12%,7%)", gap: 20, padding: "0 24px",
      textAlign: "center",
    }}>
      <LogoMark />
      <div>
        <p style={{ color: "hsl(0,0%,98%)", fontWeight: 700, fontSize: 18, margin: "0 0 6px" }}>
          STEC STATS
        </p>
        <p style={{ color: "hsl(24,6%,70%)", fontSize: 14, margin: 0 }}>
          Server starting up…
        </p>
      </div>
      <Loader2 style={{ width: 28, height: 28, color: "hsl(15,100%,55%)", animation: "spin 1s linear infinite" }} />
      <button
        onClick={onRetry}
        style={{
          marginTop: 8, display: "flex", alignItems: "center", gap: 8,
          background: "hsl(15,100%,55%)", color: "#fff",
          border: "none", borderRadius: 10, padding: "12px 28px",
          fontWeight: 700, fontSize: 16, cursor: "pointer",
        }}
      >
        <RefreshCw style={{ width: 18, height: 18 }} />
        Try again
      </button>
      <p style={{ color: "hsl(24,6%,50%)", fontSize: 12, margin: 0 }}>
        Retrying automatically every few seconds…
      </p>
    </div>
  );
}

// Shown when the React tree crashes — error boundary screen
function AppCrashScreen({ onRetry, errorMsg }: { onRetry: () => void; errorMsg?: string | null }) {
  return (
    <div style={{
      minHeight: "100dvh", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      background: "hsl(20,12%,7%)", gap: 20, padding: "0 24px",
      textAlign: "center",
    }}>
      <LogoMark />
      <div>
        <p style={{ color: "hsl(0,0%,98%)", fontWeight: 700, fontSize: 18, margin: "0 0 6px" }}>
          Something went wrong
        </p>
        <p style={{ color: "hsl(24,6%,70%)", fontSize: 14, margin: 0 }}>
          Tap below to try again
        </p>
        {errorMsg && (
          <p style={{
            color: "hsl(24,6%,45%)", fontSize: 11, margin: "10px 0 0",
            fontFamily: "monospace", wordBreak: "break-all", maxWidth: 300,
          }}>
            {errorMsg}
          </p>
        )}
      </div>
      <button
        onClick={onRetry}
        style={{
          marginTop: 8, display: "flex", alignItems: "center", gap: 8,
          background: "hsl(15,100%,55%)", color: "#fff",
          border: "none", borderRadius: 10, padding: "12px 28px",
          fontWeight: 700, fontSize: 16, cursor: "pointer",
        }}
      >
        <RefreshCw style={{ width: 18, height: 18 }} />
        Try again
      </button>
    </div>
  );
}

class AppErrorBoundary extends Component<
  { children: ReactNode },
  { crashMsg: string | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { crashMsg: null };
  }
  static getDerivedStateFromError(err: Error) {
    return { crashMsg: `${err.name}: ${err.message}` };
  }
  componentDidCatch(err: Error, _info: ErrorInfo) {
    try { localStorage.setItem("__stec_last_crash", `${err.name}: ${err.message}`); } catch {}
  }
  handleRetry = () => {
    this.setState({ crashMsg: null });
  };
  render() {
    if (this.state.crashMsg) {
      return <AppCrashScreen onRetry={this.handleRetry} errorMsg={this.state.crashMsg} />;
    }
    return this.props.children;
  }
}

function ServerReadinessGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<"checking" | "ready" | "unreachable">("checking");

  const check = useCallback(async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch("/api", { signal: ctrl.signal });
      // Treat 5xx as not-yet-ready (server booting / migration race).
      // fetch() only throws on network errors, NOT on HTTP errors, so we
      // must check the status manually. 404 from Fastify = server is up.
      if (res.status < 500) {
        setStatus("ready");
      } else {
        setStatus("unreachable");
      }
    } catch {
      setStatus("unreachable");
    } finally {
      clearTimeout(timer);
    }
  }, []);

  // Initial check on mount
  useEffect(() => { check(); }, [check]);

  // Auto-retry every 4 s while unreachable
  useEffect(() => {
    if (status !== "unreachable") return;
    const t = setInterval(check, 4000);
    return () => clearInterval(t);
  }, [status, check]);

  // Soft retry: reset to "checking" and immediately re-ping.
  // Do NOT hard-reload (window.location.reload) — that replays the full
  // cold-start race and keeps the user stuck in a loop.
  const softRetry = useCallback(() => {
    setStatus("checking");
    check();
  }, [check]);

  if (status === "checking") return <AppLoadingScreen />;
  if (status === "unreachable") return <ServerWaitScreen onRetry={softRetry} />;
  return <>{children}</>;
}

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains. Do not inline the env var, leave
// publishableKey undefined, or replace publishableKeyFromHost with anything else.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — copy verbatim. Empty in dev (Clerk hits dev FAPI directly), auto-set
// in prod. Do NOT gate on import.meta.env.PROD / NODE_ENV — the empty dev value
// is intentional, and any branching breaks the prod proxy.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

// Clerk passes full paths to routerPush/routerReplace, but wouter's
// setLocation prepends the base — strip it to avoid doubling.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.png`,
  },
  variables: {
    colorPrimary: "hsl(15, 100%, 55%)",
    colorForeground: "hsl(0, 0%, 98%)",
    colorMutedForeground: "hsl(24, 6%, 70%)",
    colorDanger: "hsl(0, 84%, 60%)",
    colorBackground: "hsl(20, 12%, 7%)",
    colorInput: "hsl(20, 8%, 12%)",
    colorInputForeground: "hsl(0, 0%, 98%)",
    colorNeutral: "hsl(22, 8%, 16%)",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.25rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card rounded-2xl w-[440px] max-w-full overflow-hidden border border-border",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground font-display text-3xl",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground",
    formFieldLabel: "text-foreground",
    footerActionLink: "text-primary hover:text-primary/90",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-foreground",
    alertText: "text-foreground",
    logoBox: "flex justify-center py-4",
    logoImage: "h-10 w-auto max-w-[200px] object-contain",
    socialButtonsBlockButton: "border-border hover:bg-accent",
    formButtonPrimary: "bg-primary hover:bg-primary/90 text-primary-foreground",
    formFieldInput: "bg-input text-foreground border-border",
    footerAction: "text-muted-foreground",
    dividerLine: "bg-border",
    alert: "bg-destructive/10 border-destructive/40",
    otpCodeFieldInput: "bg-input text-foreground border-border",
    formFieldRow: "",
    main: "",
  },
};

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Home />
      </Show>
    </>
  );
}

// Fired-once checkout resumption for a user who picked a plan on the public
// pricing page while signed out, then completed sign-up. Reads the pending
// interval left in sessionStorage and immediately kicks off Stripe Checkout.
function PendingCheckoutResumer() {
  const { toast } = useToast();
  const checkout = useCreateCheckoutSession();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    const intent = decodeCheckoutIntent(sessionStorage.getItem(PENDING_CHECKOUT_KEY));
    if (!intent) return;
    startedRef.current = true;
    sessionStorage.removeItem(PENDING_CHECKOUT_KEY);
    checkout
      .mutateAsync({ data: { interval: intent.interval, tier: intent.tier } })
      .then((res) => {
        window.location.href = res.url;
      })
      .catch(() => {
        try { localStorage.setItem(FAILED_CHECKOUT_KEY, encodeCheckoutIntent(intent)); } catch {}
        toast({
          title: "Checkout didn't open",
          description: "No worries — head to Billing to start your free trial.",
          variant: "destructive",
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

// Routes a brand-new signed-in user (no players yet) into the guided
// onboarding flow instead of dropping them straight onto an empty dashboard.
function OnboardingGate({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: players, isLoading } = useListPlayers();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-20">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const hasPlayers = (players?.length ?? 0) > 0;

  if (!hasPlayers && location !== "/onboarding") {
    return <Redirect to="/onboarding" />;
  }

  return <>{children}</>;
}

function VideoUploadBanner() {
  const state = useSyncExternalStore(
    backgroundUpload.subscribe,
    backgroundUpload.getSnapshot,
  );
  if (!state) return null;

  return (
    <div className="fixed bottom-20 md:bottom-4 right-4 z-50 bg-zinc-900 border border-zinc-700 rounded-xl p-3 shadow-2xl flex items-center gap-3 w-72">
      {state.status === "uploading" && (
        <>
          <Loader2 className="w-4 h-4 animate-spin text-orange-500 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">Uploading game video</p>
            <div className="mt-1.5 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-orange-500 rounded-full transition-all duration-300"
                style={{ width: `${state.progress}%` }}
              />
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">{state.progress}% · vs {state.opponent}</p>
          </div>
          {/* Let the user cancel a stalled upload so they can move somewhere
              with better signal and tap Retry, instead of waiting 10 minutes
              for the timeout. */}
          <button
            onClick={() => backgroundUpload.cancel()}
            className="text-zinc-500 hover:text-white ml-1 shrink-0"
            aria-label="Cancel upload"
            title="Cancel and retry later"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </>
      )}
      {state.status === "attaching" && (
        <>
          <Loader2 className="w-4 h-4 animate-spin text-orange-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-white">Saving video…</p>
            <p className="text-xs text-zinc-400">vs {state.opponent}</p>
          </div>
        </>
      )}
      {state.status === "done" && (
        <>
          <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-white">Video saved!</p>
            <p className="text-xs text-zinc-400">Highlights are generating in the background</p>
          </div>
        </>
      )}
      {state.status === "retrying" && (
        <>
          <RefreshCw className="w-4 h-4 animate-spin text-orange-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">Retrying upload…</p>
            <p className="text-xs text-zinc-400">Attempt {(state.retryAttempt ?? 1) + 1} of 3 · vs {state.opponent}</p>
          </div>
        </>
      )}
      {state.status === "failed" && (
        <>
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white">Upload failed</p>
            <p className="text-xs text-zinc-400 truncate">{state.error ?? "Check your connection and tap Retry"}</p>
          </div>
          {backgroundUpload.hasRetry() && (
            <button
              onClick={() => backgroundUpload.retry()}
              className="flex items-center gap-1 text-orange-400 hover:text-orange-300 ml-1 text-xs font-semibold whitespace-nowrap"
              aria-label="Retry upload"
            >
              <RefreshCw className="w-3 h-3" />
              Retry
            </button>
          )}
          <button
            onClick={() => backgroundUpload.dismiss()}
            className="text-zinc-500 hover:text-white ml-1"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

const PENDING_VIDEO_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

declare function gtag(...args: unknown[]): void;
const ADS_CONVERSION_KEY = "stec:ads-conversion-fired";

function SignupConversionTracker() {
  const { data: players, isLoading } = useListPlayers();

  useEffect(() => {
    if (isLoading) return;
    try {
      if (localStorage.getItem(ADS_CONVERSION_KEY)) return;
    } catch { return; }

    const isNewUser = (players?.length ?? 0) === 0;
    if (!isNewUser) {
      try { localStorage.setItem(ADS_CONVERSION_KEY, "1"); } catch {}
      return;
    }

    try {
      gtag("event", "conversion", { send_to: "AW-11081270024/OET1CPKO9vUYEIiG-6Mp" });
      localStorage.setItem(ADS_CONVERSION_KEY, "1");
    } catch {}
  }, [isLoading, players]);

  return null;
}

type PendingEntry = { gameId: number; opponent: string; sessionId: string; mimeType: string | null; savedAt: number };

/** Read all pending entries from the new array key + old single-slot key. */
function readPendingQueue(): PendingEntry[] {
  const results: PendingEntry[] = [];
  try {
    // New array-based queue (current format).
    const arr = JSON.parse(localStorage.getItem(PENDING_VIDEO_UPLOADS_KEY) ?? "[]");
    if (Array.isArray(arr)) results.push(...(arr as PendingEntry[]));
  } catch { /* ignore */ }
  try {
    // Legacy single-slot key — migrate into results if present.
    const raw = localStorage.getItem(PENDING_VIDEO_UPLOAD_KEY);
    if (raw) {
      const entry = JSON.parse(raw) as PendingEntry;
      if (entry?.gameId && !results.some(e => e.gameId === entry.gameId)) {
        results.push(entry);
      }
      localStorage.removeItem(PENDING_VIDEO_UPLOAD_KEY);
    }
  } catch { /* ignore */ }
  return results;
}

function removePendingEntry(gameId: number) {
  try {
    const arr = JSON.parse(localStorage.getItem(PENDING_VIDEO_UPLOADS_KEY) ?? "[]");
    const filtered = (Array.isArray(arr) ? arr as PendingEntry[] : []).filter(e => e.gameId !== gameId);
    if (filtered.length === 0) localStorage.removeItem(PENDING_VIDEO_UPLOADS_KEY);
    else localStorage.setItem(PENDING_VIDEO_UPLOADS_KEY, JSON.stringify(filtered));
  } catch { /* ignore */ }
}

/**
 * On mount, picks up any game recordings that were saved but whose video
 * upload didn't complete (network drop, page reload, app close). Processes
 * them in sequence so all games from a multi-game session are recovered, not
 * just the most-recently saved one.
 */
function PendingVideoUploadRecoverer() {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;

    const queue = readPendingQueue();
    if (queue.length === 0) return;

    // Filter out stale entries (older than 7 days).
    const now = Date.now();
    const fresh = queue.filter(e => now - e.savedAt <= PENDING_VIDEO_MAX_AGE_MS);
    const stale = queue.filter(e => now - e.savedAt > PENDING_VIDEO_MAX_AGE_MS);
    stale.forEach(e => { removePendingEntry(e.gameId); deleteSession(e.sessionId).catch(() => {}); });
    if (fresh.length === 0) return;

    // Don't double-start if backgroundUpload is already running for the first
    // entry in the queue (e.g. this component unmounted and remounted).
    const current = backgroundUpload.getSnapshot();
    const firstUploading = current && fresh.some(e => e.gameId === current.gameId);
    if (firstUploading) return;

    startedRef.current = true;

    // Process all pending entries in sequence. Each awaits the previous so
    // the upload banner only shows one game at a time.
    (async () => {
      for (const pending of fresh) {
        try {
          const gameRes = await fetch(`/api/games/${pending.gameId}`);
          if (!gameRes.ok) {
            removePendingEntry(pending.gameId);
            deleteSession(pending.sessionId).catch(() => {});
            continue;
          }
          const game = await gameRes.json();
          if (game.videoObjectPath) {
            // Already uploaded (possibly by the original in-memory upload).
            removePendingEntry(pending.gameId);
            deleteSession(pending.sessionId).catch(() => {});
            continue;
          }

          const chunks = await getOrderedChunks(pending.sessionId);
          if (chunks.length === 0) {
            removePendingEntry(pending.gameId);
            continue;
          }

          const blob = new Blob(chunks, { type: pending.mimeType || "video/webm" });
          const { gameId, opponent, sessionId } = pending;

          // Await so the next game in the queue only starts after this one
          // completes or fails. On network failure the banner shows Retry;
          // once dismissed the loop continues to the next game.
          await backgroundUpload.start(
            gameId,
            opponent,
            (onProgress, signal) => uploadVideoBlob(blob, onProgress, signal),
            async (objectPath) => {
              const patchRes = await fetch(`/api/games/${gameId}/video`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ videoObjectPath: objectPath }),
              });
              if (!patchRes.ok) throw new Error("Failed to attach video to game");
              deleteSession(sessionId).catch(() => {});
              removePendingEntry(gameId);
              fetch(`/api/games/${gameId}/highlight`, { method: "POST" }).catch(() => {});
              fetch(`/api/games/${gameId}/lowlight`, { method: "POST" }).catch(() => {});
            },
          );
        } catch {
          // Network/parse error on this entry — leave it in localStorage for
          // the next app load to retry.
        }
      }
      startedRef.current = false;
    })();
  }, []);

  return null;
}

function ProtectedApp() {
  return (
    <>
      <Show when="signed-in">
        <PendingCheckoutResumer />
        <PendingVideoUploadRecoverer />
        <SignupConversionTracker />
        <Layout>
          <OnboardingGate>
            <Switch>
              <Route path="/dashboard" component={Dashboard} />
              <Route path="/onboarding" component={Onboarding} />
              <Route path="/record" component={RecordGame} />
              <Route path="/record/:id" component={RecordGame} />
              <Route path="/import" component={ImportData} />
              <Route path="/billing" component={Billing} />
              <Route component={NotFound} />
            </Switch>
          </OnboardingGate>
        </Layout>
        <VideoUploadBanner />
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 gap-6">
      <img src="/logo.png" alt="StecStats" className="h-12 w-auto object-contain drop-shadow-[0_0_12px_rgba(249,115,22,0.5)]" />
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4 gap-6">
      <img src="/logo.png" alt="StecStats" className="h-12 w-auto object-contain drop-shadow-[0_0_12px_rgba(249,115,22,0.5)]" />
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

// Helps user's webview stay up-to-date when the signed-in user changes by invalidating the QueryClient cache.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back, coach",
            subtitle: "Sign in to access your team dashboard",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Set up your private team dashboard",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Switch>
            <Route path="/watch/:code" component={WatchStream} />
            <Route path="/pricing" component={Pricing} />
            <Route path="/print-cards" component={PrintCards} />
            <Route path="/card-render" component={CardRender} />
            <Route path="/admin" component={AdminFeedback} />
            <Route path="/" component={HomeRedirect} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route component={ProtectedApp} />
          </Switch>
          <FeedbackButton />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <AppErrorBoundary>
      <ServerReadinessGate>
        <WouterRouter base={basePath}>
          <ClerkProviderWithRoutes />
        </WouterRouter>
      </ServerReadinessGate>
    </AppErrorBoundary>
  );
}

export default App;
