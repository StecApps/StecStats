import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  useListPlayers,
  useCreatePlayer,
  useDeletePlayer,
  useListTeams,
  useCreateTeam,
  getListPlayersQueryKey,
  getListTeamsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, User, Trophy, ArrowRight, PartyPopper, Link, Plus, Zap, CheckCircle2, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Step = "player" | "team" | "done";

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: players, isLoading: playersLoading } = useListPlayers();
  const { data: teams, isLoading: teamsLoading } = useListTeams();

  const createPlayer = useCreatePlayer();
  const deletePlayer = useDeletePlayer();
  const createTeam = useCreateTeam();

  const [playerName, setPlayerName] = useState("");
  const [teamName, setTeamName] = useState("");

  // All players confirmed during this onboarding session (store id + name so we can delete)
  const [confirmedPlayers, setConfirmedPlayers] = useState<{ id: number; name: string }[]>([]);
  const [confirmedTeamName, setConfirmedTeamName] = useState<string>("");

  // Whether the free-plan limit was hit during this session
  const [limitHit, setLimitHit] = useState(false);

  // Key written to sessionStorage when the coach clicks "Upgrade to Pro" so
  // that handleCreatePlayer knows to retry on 403 (the webhook may not have
  // fired yet when they navigate back from Stripe).
  const RECENTLY_UPGRADED_KEY = "hoops_recently_upgraded_ts";

  // Whether the user has explicitly chosen to move to the team step
  const [proceedToTeam, setProceedToTeam] = useState(false);

  // Existing players from before this session
  const existingPlayers = players ?? [];

  // All players shown in the list: existing (from server) merged with newly
  // confirmed (local), deduplicated by ID. After creating a player we both
  // invalidate the query AND push to confirmedPlayers so the item appears
  // immediately before the refetch returns — deduplication ensures the same
  // player isn't counted or rendered twice once the refetch completes.
  const existingPlayerIds = new Set(existingPlayers.map((p) => p.id));
  const allPlayers: { id: number; name: string }[] = [
    ...existingPlayers.map((p) => ({ id: p.id, name: p.name })),
    ...confirmedPlayers.filter((cp) => !existingPlayerIds.has(cp.id)),
  ];

  const totalPlayers = allPlayers.length;
  const hasAnyPlayer = totalPlayers > 0;
  const hasTeam = (teams?.length ?? 0) > 0;

  // Determine the current step:
  // - "player" if no player exists yet
  // - "player" (add-more mode) if players exist but the coach hasn't explicitly continued
  // - "team" once the coach clicked Continue to Team or a team already exists
  // - "done" once a team exists
  const step: Step = !hasAnyPlayer
    ? "player"
    : !hasTeam && !proceedToTeam
    ? "player"
    : hasTeam
    ? "done"
    : "team";

  // For the team/done steps: use the first confirmed player name, falling back
  // to the first pre-existing player name.
  const primaryPlayerName =
    confirmedPlayers[0]?.name || existingPlayers[0]?.name || "";

  // All player names shown on the done screen
  const allPlayerNames: string[] = allPlayers.map((p) => p.name);

  // A fully-onboarded coach who navigates back to /onboarding should be sent
  // straight to /dashboard. Only skip this redirect when the coach just
  // completed the flow in this session (i.e. confirmedTeamName is set).
  useEffect(() => {
    if (!playersLoading && !teamsLoading && step === "done" && !confirmedTeamName) {
      setLocation("/dashboard");
    }
  }, [playersLoading, teamsLoading, step, confirmedTeamName, setLocation]);

  if (playersLoading || teamsLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }


  const existingTeamName = teams?.[0]?.name ?? "";
  const resolvedTeamName = confirmedTeamName || existingTeamName;

  const handleCreatePlayer = async () => {
    if (!playerName.trim()) return;

    // If the coach just upgraded (stamp < 5 minutes old), retry on 403 up to
    // two extra times with a 2-second delay.  The Stripe webhook can lag a few
    // seconds after checkout, so we give the server a brief window to catch up
    // before showing a false "upgrade required" banner.
    const recentlyUpgradedTs = (() => {
      try { return Number(sessionStorage.getItem(RECENTLY_UPGRADED_KEY)) || 0; } catch { return 0; }
    })();
    const recentlyUpgraded = Date.now() - recentlyUpgradedTs < 5 * 60 * 1000;
    const maxAttempts = recentlyUpgraded ? 3 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 2000));
      }
      try {
        const player = await createPlayer.mutateAsync({ data: { name: playerName.trim() } });
        queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
        setConfirmedPlayers((prev) => [...prev, { id: player.id, name: player.name }]);
        setPlayerName("");
        // Upgrade confirmed — clear the stamp so future 403s are immediate.
        try { sessionStorage.removeItem(RECENTLY_UPGRADED_KEY); } catch {}
        toast({ title: "Player added", description: `${playerName.trim()} is on the roster.` });
        return;
      } catch (err: unknown) {
        // Check for the free-plan limit response (ApiError.status + ApiError.data.code)
        const anyErr = err as { status?: number; data?: { code?: string } };
        if (anyErr?.status === 403 || anyErr?.data?.code === "UPGRADE_REQUIRED") {
          if (attempt < maxAttempts - 1) {
            // Silent retry — webhook may not have fired yet.
            continue;
          }
          setLimitHit(true);
          return;
        }
        const description =
          err instanceof Error
            ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "")
            : "Failed to add player";
        toast({ title: "Error", description, variant: "destructive" });
        return;
      }
    }
  };

  const handleRemovePlayer = async (playerId: number, playerName: string) => {
    try {
      await deletePlayer.mutateAsync({ playerId });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      setConfirmedPlayers((prev) => prev.filter((p) => p.id !== playerId));
      // If this player was in existingPlayers (pre-session), the query invalidation
      // will remove them from that list automatically. Either way, if we were at
      // the limit, removing a player opens the slot again.
      setLimitHit(false);
      toast({ title: "Player removed", description: `${playerName} was removed from the roster.` });
    } catch (err) {
      const description =
        err instanceof Error
          ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "")
          : "Failed to remove player";
      toast({ title: "Error", description, variant: "destructive" });
    }
  };

  const handleCreateTeam = async () => {
    if (!teamName.trim()) return;
    try {
      await createTeam.mutateAsync({ data: { name: teamName.trim() } });
      queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
      setConfirmedTeamName(teamName.trim());
      toast({ title: "Team added", description: `${teamName.trim()} is ready.` });
    } catch (err) {
      const description =
        err instanceof Error
          ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "")
          : "Failed to add team";
      toast({ title: "Error", description, variant: "destructive" });
    }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        {/* Progress dots */}
        <div className="flex items-center justify-center gap-2">
          {(["player", "team", "done"] as const).map((s, i) => (
            <div
              key={s}
              className={`h-1.5 w-10 rounded-full transition-colors ${
                (step === "player" && i === 0) ||
                (step === "team" && i <= 1) ||
                step === "done"
                  ? "bg-primary"
                  : "bg-muted"
              }`}
            />
          ))}
        </div>

        {/* ── PLAYER STEP ── */}
        {step === "player" && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <User className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="font-display text-2xl uppercase tracking-wide">
                {hasAnyPlayer ? "Add players to your roster" : "Add your first player"}
              </CardTitle>
              <CardDescription>
                {hasAnyPlayer
                  ? "Add as many players as you track, then continue to your team."
                  : "Every stat, game, and highlight in STEC STATS is organized around a player."}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Confirmed players list */}
              {allPlayers.length > 0 && (
                <ul className="space-y-1.5" data-testid="onboarding-player-list">
                  {allPlayers.map((player) => (
                    <li
                      key={player.id}
                      className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm font-medium"
                    >
                      <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                      <span className="flex-1">{player.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${player.name}`}
                        data-testid="button-remove-player"
                        onClick={() => handleRemovePlayer(player.id, player.name)}
                        disabled={deletePlayer.isPending}
                        className="text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* Upgrade prompt when free limit is hit */}
              {limitHit ? (
                <div
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm space-y-2"
                  data-testid="onboarding-upgrade-prompt"
                >
                  <p className="font-medium text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    <Zap className="w-4 h-4 shrink-0" />
                    Free plan — 1 player limit reached
                  </p>
                  <p className="text-muted-foreground">
                    Upgrade to Pro to track unlimited players.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      try { sessionStorage.setItem(RECENTLY_UPGRADED_KEY, String(Date.now())); } catch {}
                      setLocation("/billing");
                    }}
                  >
                    Upgrade to Pro
                  </Button>
                </div>
              ) : (
                /* Add-player form */
                <div className="space-y-2">
                  <Label htmlFor="onboarding-player-name">
                    {hasAnyPlayer ? "Another player's name" : "Player Name"}
                  </Label>
                  <Input
                    id="onboarding-player-name"
                    data-testid="input-onboarding-player-name"
                    value={playerName}
                    onChange={(e) => setPlayerName(e.target.value)}
                    placeholder="e.g. Jordan Smith"
                    onKeyDown={(e) => e.key === "Enter" && handleCreatePlayer()}
                    autoFocus
                  />
                  <Button
                    className="w-full font-display uppercase tracking-wide"
                    onClick={handleCreatePlayer}
                    disabled={!playerName.trim() || createPlayer.isPending}
                    data-testid="button-onboarding-add-player"
                  >
                    {createPlayer.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Plus className="w-4 h-4 mr-2" />
                    )}
                    {hasAnyPlayer ? "Add Player" : "Add Player"}
                  </Button>
                </div>
              )}

              {/* Continue to team — only shown once at least one player exists */}
              {hasAnyPlayer && (
                <Button
                  variant="ghost"
                  className="w-full font-display uppercase tracking-wide text-muted-foreground hover:text-foreground"
                  onClick={() => setProceedToTeam(true)}
                  data-testid="button-onboarding-continue-to-team"
                >
                  Continue to Team <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── TEAM STEP ── */}
        {step === "team" && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <Trophy className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="font-display text-2xl uppercase tracking-wide">
                {primaryPlayerName ? `Add ${primaryPlayerName}'s team` : "Add a team or season"}
              </CardTitle>
              <CardDescription>
                {primaryPlayerName
                  ? `Which team or season does ${primaryPlayerName} play for? (e.g. "Travel 24-25'" or "Varsity Fall")`
                  : `Group games by team and season — like "Travel 24-25'" or "Varsity Fall".`}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="onboarding-team-name">Team / Season Name</Label>
                <Input
                  id="onboarding-team-name"
                  data-testid="input-onboarding-team-name"
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  placeholder="e.g. Travel 24-25'"
                  onKeyDown={(e) => e.key === "Enter" && handleCreateTeam()}
                  autoFocus
                />
              </div>
              <Button
                className="w-full font-display uppercase tracking-wide"
                onClick={handleCreateTeam}
                disabled={!teamName.trim() || createTeam.isPending}
                data-testid="button-onboarding-create-team"
              >
                {createTeam.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Continue <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* ── DONE STEP ── */}
        {step === "done" && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <PartyPopper className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="font-display text-2xl uppercase tracking-wide">You're all set</CardTitle>
              <CardDescription>
                {allPlayerNames.length > 0 && resolvedTeamName
                  ? `Record your first game under ${resolvedTeamName} and your players will be linked automatically.`
                  : "Head to your dashboard, then record your first game to see stats roll in."}
              </CardDescription>
            </CardHeader>

            {(allPlayerNames.length > 0 || resolvedTeamName) && (
              <CardContent className="pb-4 space-y-3">
                {/* Players list */}
                {allPlayerNames.length > 0 && (
                  <div className="rounded-lg bg-muted/50 px-4 py-3 space-y-1.5">
                    {allPlayerNames.map((name) => (
                      <div
                        key={name}
                        className="flex items-center gap-1.5 text-sm font-medium"
                        data-testid="done-player-name"
                      >
                        <User className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        {name}
                      </div>
                    ))}
                  </div>
                )}

                {/* Team */}
                {resolvedTeamName && (
                  <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-4 py-3 text-sm">
                    {allPlayerNames.length > 0 && (
                      <Link className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="flex items-center gap-1.5 font-medium">
                      <Trophy className="w-3.5 h-3.5 text-muted-foreground" />
                      {resolvedTeamName}
                    </span>
                  </div>
                )}

                <p className="text-center text-xs text-muted-foreground">
                  Linked automatically when you record your first game
                </p>
              </CardContent>
            )}

            <CardContent>
              <Button
                className="w-full font-display uppercase tracking-wide"
                onClick={() => setLocation("/dashboard")}
                data-testid="button-onboarding-finish"
              >
                Go to Dashboard <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
