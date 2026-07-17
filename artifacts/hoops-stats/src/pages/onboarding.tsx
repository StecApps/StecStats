import { useState } from "react";
import { useLocation } from "wouter";
import {
  useListPlayers,
  useCreatePlayer,
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
import { Loader2, User, Trophy, ArrowRight, PartyPopper, Link } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type Step = "player" | "team" | "done";

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: players, isLoading: playersLoading } = useListPlayers();
  const { data: teams, isLoading: teamsLoading } = useListTeams();

  const createPlayer = useCreatePlayer();
  const createTeam = useCreateTeam();

  const [playerName, setPlayerName] = useState("");
  const [teamName, setTeamName] = useState("");

  // Track the names that were successfully confirmed so we can reference them
  // in subsequent steps and on the done screen.
  const [confirmedPlayerName, setConfirmedPlayerName] = useState<string>("");
  const [confirmedTeamName, setConfirmedTeamName] = useState<string>("");
  const [justFinishedPlayer, setJustFinishedPlayer] = useState(false);

  if (playersLoading || teamsLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // If the coach already had a player before onboarding, use the first one's
  // name as the confirmed player so the team step still personalises correctly.
  const existingPlayerName = players?.[0]?.name ?? "";
  const resolvedPlayerName = confirmedPlayerName || existingPlayerName;

  const hasPlayer = (players?.length ?? 0) > 0 || justFinishedPlayer;
  const hasTeam = (teams?.length ?? 0) > 0;
  const step: Step = !hasPlayer ? "player" : !hasTeam ? "team" : "done";

  // Likewise, fall back to the first existing team name for the done screen.
  const existingTeamName = teams?.[0]?.name ?? "";
  const resolvedTeamName = confirmedTeamName || existingTeamName;

  const handleCreatePlayer = async () => {
    if (!playerName.trim()) return;
    try {
      await createPlayer.mutateAsync({ data: { name: playerName.trim() } });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      setConfirmedPlayerName(playerName.trim());
      setJustFinishedPlayer(true);
      toast({ title: "Player added", description: `${playerName.trim()} is on the roster.` });
    } catch (err) {
      const description = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : "Failed to add player";
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
      const description = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : "Failed to add team";
      toast({ title: "Error", description, variant: "destructive" });
    }
  };

  return (
    <div className="min-h-[100dvh] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
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

        {step === "player" && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <User className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="font-display text-2xl uppercase tracking-wide">Add your first player</CardTitle>
              <CardDescription>Every stat, game, and highlight in STEC STATS is organized around a player.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="onboarding-player-name">Player Name</Label>
                <Input
                  id="onboarding-player-name"
                  data-testid="input-onboarding-player-name"
                  value={playerName}
                  onChange={(e) => setPlayerName(e.target.value)}
                  placeholder="e.g. Jordan Smith"
                  onKeyDown={(e) => e.key === "Enter" && handleCreatePlayer()}
                  autoFocus
                />
              </div>
              <Button
                className="w-full font-display uppercase tracking-wide"
                onClick={handleCreatePlayer}
                disabled={!playerName.trim() || createPlayer.isPending}
                data-testid="button-onboarding-create-player"
              >
                {createPlayer.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Continue <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </CardContent>
          </Card>
        )}

        {step === "team" && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <Trophy className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="font-display text-2xl uppercase tracking-wide">
                {resolvedPlayerName ? `Add ${resolvedPlayerName}'s team` : "Add a team or season"}
              </CardTitle>
              <CardDescription>
                {resolvedPlayerName
                  ? `Which team or season does ${resolvedPlayerName} play for? (e.g. "Travel 24-25'" or "Varsity Fall")`
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

        {step === "done" && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                <PartyPopper className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="font-display text-2xl uppercase tracking-wide">You're all set</CardTitle>
              <CardDescription>
                {resolvedPlayerName && resolvedTeamName
                  ? `Record your first game for ${resolvedPlayerName} under ${resolvedTeamName} and they'll be linked automatically.`
                  : "Head to your dashboard, then record your first game to see stats roll in."}
              </CardDescription>
            </CardHeader>
            {(resolvedPlayerName || resolvedTeamName) && (
              <CardContent className="pb-4">
                <div className="flex items-center justify-center gap-3 rounded-lg bg-muted/50 px-4 py-3 text-sm">
                  {resolvedPlayerName && (
                    <span className="flex items-center gap-1.5 font-medium">
                      <User className="w-3.5 h-3.5 text-muted-foreground" />
                      {resolvedPlayerName}
                    </span>
                  )}
                  {resolvedPlayerName && resolvedTeamName && (
                    <Link className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  )}
                  {resolvedTeamName && (
                    <span className="flex items-center gap-1.5 font-medium">
                      <Trophy className="w-3.5 h-3.5 text-muted-foreground" />
                      {resolvedTeamName}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-center text-xs text-muted-foreground">
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
