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
import { Loader2, User, Trophy, ArrowRight, PartyPopper } from "lucide-react";
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
  const [justFinishedPlayer, setJustFinishedPlayer] = useState(false);

  if (playersLoading || teamsLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const hasPlayer = (players?.length ?? 0) > 0 || justFinishedPlayer;
  const hasTeam = (teams?.length ?? 0) > 0;
  const step: Step = !hasPlayer ? "player" : !hasTeam ? "team" : "done";

  const handleCreatePlayer = async () => {
    if (!playerName.trim()) return;
    try {
      await createPlayer.mutateAsync({ data: { name: playerName.trim() } });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
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
              <CardTitle className="font-display text-2xl uppercase tracking-wide">Add a team or season</CardTitle>
              <CardDescription>Group games by team and season — like "Travel 24-25'" or "Varsity Fall".</CardDescription>
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
              <CardDescription>Head to your dashboard, then record your first game to see stats roll in.</CardDescription>
            </CardHeader>
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
