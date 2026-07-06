import { useState } from "react";
import { 
  useListPlayers, 
  useCreatePlayer, 
  useUpdatePlayer, 
  useDeletePlayer,
  useGetPlayerSummary,
  useListPlayerTeamGroups,
  useListTeamGames,
  useListTeams,
  useCreateTeam,
  useUpdateTeam,
  useDeleteTeam,
  useDeleteGame,
  getListPlayersQueryKey,
  getGetPlayerSummaryQueryKey,
  getListPlayerTeamGroupsQueryKey,
  getListTeamGamesQueryKey,
  getListTeamsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Settings, Trash2, Edit, ChevronDown, Trophy, Activity, CalendarDays, ListTree, Zap } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: players, isLoading: playersLoading } = useListPlayers();
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);

  const [isAddPlayerOpen, setIsAddPlayerOpen] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState("");

  const createPlayer = useCreatePlayer();

  const handleCreatePlayer = async () => {
    if (!newPlayerName.trim()) return;
    try {
      const p = await createPlayer.mutateAsync({ data: { name: newPlayerName.trim() } });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      setIsAddPlayerOpen(false);
      setNewPlayerName("");
      setSelectedPlayerId(p.id);
      toast({ title: "Player added", description: `Added ${p.name}` });
    } catch (err) {
      const description = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : "Failed to add player";
      toast({ title: "Error", description, variant: "destructive" });
    }
  };

  if (playersLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const activePlayerId = selectedPlayerId || (players && players.length > 0 ? players[0].id : null);

  return (
    <div className="flex flex-col space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-4xl font-display font-bold uppercase tracking-tight text-secondary">Dashboard</h1>
          <p className="text-muted-foreground">Select a player to view career and game-by-game stats.</p>
        </div>
        
        <div className="flex gap-2">
          <ManageTeamsDialog
            trigger={<Button variant="outline" className="font-display text-lg uppercase tracking-wide"><ListTree className="w-4 h-4 mr-2" /> Manage Teams</Button>}
          />
          <Dialog open={isAddPlayerOpen} onOpenChange={setIsAddPlayerOpen}>
            <DialogTrigger asChild>
              <Button className="font-display text-lg uppercase tracking-wide">
                <Plus className="w-4 h-4 mr-2" /> Add Player
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle className="font-display uppercase text-2xl">Add New Player</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Player Name</Label>
                  <Input 
                    id="name" 
                    value={newPlayerName} 
                    onChange={(e) => setNewPlayerName(e.target.value)} 
                    placeholder="Enter player name" 
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setIsAddPlayerOpen(false)}>Cancel</Button>
                <Button onClick={handleCreatePlayer} disabled={createPlayer.isPending || !newPlayerName.trim()}>
                  {createPlayer.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {players && players.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {players.map(p => (
            <PlayerChip
              key={p.id}
              playerId={p.id}
              name={p.name}
              active={activePlayerId === p.id}
              onClick={() => setSelectedPlayerId(p.id)}
            />
          ))}
        </div>
      ) : (
        <Card className="border-dashed border-2 border-muted bg-transparent">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <Plus className="w-8 h-8 text-primary" />
            </div>
            <h3 className="text-xl font-display font-bold uppercase mb-2">No Players Found</h3>
            <p className="text-muted-foreground mb-4">Add your first player to start tracking stats.</p>
            <Button onClick={() => setIsAddPlayerOpen(true)}>Add Player</Button>
          </CardContent>
        </Card>
      )}

      {activePlayerId && (
        <PlayerDashboard playerId={activePlayerId} player={players?.find(p => p.id === activePlayerId)} />
      )}
    </div>
  );
}

function PlayerDashboard({ playerId, player }: { playerId: number, player?: {id: number, name: string} }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const { data: summary, isLoading: summaryLoading } = useGetPlayerSummary(playerId, {
    query: { enabled: !!playerId, queryKey: getGetPlayerSummaryQueryKey(playerId) }
  });

  const { data: teams, isLoading: teamsLoading } = useListPlayerTeamGroups(playerId, {
    query: { enabled: !!playerId, queryKey: getListPlayerTeamGroupsQueryKey(playerId) }
  });

  const updatePlayer = useUpdatePlayer();
  const deletePlayer = useDeletePlayer();
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editName, setEditName] = useState(player?.name || "");

  const handleUpdate = async () => {
    if (!editName.trim()) return;
    try {
      await updatePlayer.mutateAsync({ playerId, data: { name: editName } });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      setIsEditOpen(false);
      toast({ title: "Player updated" });
    } catch(err) {
      toast({ title: "Error updating player", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure? This deletes all stats for this player.")) return;
    try {
      await deletePlayer.mutateAsync({ playerId });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      toast({ title: "Player deleted" });
    } catch(err) {
      toast({ title: "Error deleting player", variant: "destructive" });
    }
  };

  if (summaryLoading || teamsLoading) {
    return (
      <div className="flex-1 flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!summary) return null;

  const winRate = summary.games > 0 ? (summary.wins / summary.games) * 100 : 0;

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* JUMBOTRON HERO */}
      <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-card/40 px-4 py-10 md:py-14 text-center">
        <div className="pointer-events-none absolute inset-0 [background:radial-gradient(ellipse_55%_75%_at_50%_25%,hsl(var(--primary)/0.28),transparent_70%)]" />
        <div className="relative flex flex-col items-center">
          <p className="flex items-center gap-2 text-[0.65rem] md:text-xs font-bold uppercase tracking-[0.35em] text-primary">
            <Zap className="w-3.5 h-3.5 fill-primary" /> Live Player Stats <Zap className="w-3.5 h-3.5 fill-primary" />
          </p>
          <h1 className="mt-3 font-display font-bold uppercase leading-[0.85] tracking-tight text-6xl md:text-8xl text-jumbotron break-words max-w-full">
            {player?.name ?? "Player"}
          </h1>
          <div className="mt-5 flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-4 py-1.5 text-[0.65rem] font-bold uppercase tracking-[0.25em] text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" /> Career Summary Dashboard
            </span>
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="icon" className="h-8 w-8 rounded-full" aria-label="Manage player">
                  <Settings className="w-4 h-4" />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Manage Player</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input value={editName} onChange={e => setEditName(e.target.value)} />
                  </div>
                </div>
                <DialogFooter className="flex justify-between sm:justify-between items-center">
                  <Button variant="destructive" onClick={handleDelete}><Trash2 className="w-4 h-4 mr-2"/> Delete</Button>
                  <div className="flex gap-2">
                    <Button variant="outline" onClick={() => setIsEditOpen(false)}>Cancel</Button>
                    <Button onClick={handleUpdate}>Save</Button>
                  </div>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      {/* HEADLINE STAT PANEL */}
      <div className="grid grid-cols-2 md:grid-cols-4 rounded-xl border border-border/60 bg-card/40 divide-x divide-border/60 overflow-hidden">
        <HeadlineStat label="Points / GM" value={summary.ppg.toFixed(1)} sub={`${summary.points} total`} />
        <HeadlineStat label="Games Played" value={summary.games} sub={`${summary.wins}W · ${summary.losses}L`} />
        <HeadlineStat label="Win Record" value={`${summary.wins}-${summary.losses}`} sub={`${winRate.toFixed(0)}% win rate`} className="border-t md:border-t-0 border-border/60" />
        <HeadlineStat label="Rebounds / GM" value={summary.rpg.toFixed(1)} sub={`${summary.rebounds} total`} className="border-t md:border-t-0 border-border/60" />
      </div>

      {/* SHOOTING EFFICIENCY */}
      <div>
        <SectionHeader title="Shooting Efficiency" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <GaugeCard label="Field Goal" value={summary.fgPct} made={summary.twoMade + summary.threeMade} attempted={summary.twoAttempted + summary.threeAttempted} />
          <GaugeCard label="3-Point" value={summary.threePct} made={summary.threeMade} attempted={summary.threeAttempted} />
          <GaugeCard label="Free Throw" value={summary.ftPct} made={summary.ftMade} attempted={summary.ftAttempted} />
        </div>
      </div>

      {/* PLAYMAKING & DEFENSE */}
      <div>
        <SectionHeader title="Playmaking & Defense" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatBox label="Assists / GM" value={summary.apg.toFixed(1)} sub={`${summary.assists} total`} />
          <StatBox label="Steals / GM" value={summary.spg.toFixed(1)} sub={`${summary.steals} total`} />
          <StatBox label="Blocks / GM" value={summary.bpg.toFixed(1)} sub={`${summary.blocks} total`} />
          <StatBox label="Turnovers / GM" value={summary.topg.toFixed(1)} sub={`${summary.turnovers} total`} />
        </div>
      </div>
      
      <div className="mt-8">
        <div className="flex justify-between items-center mb-4 border-b-2 border-secondary/10 pb-2">
          <h2 className="text-2xl font-display font-bold uppercase text-secondary">Teams & Seasons</h2>
          <ManageTeamsDialog
            trigger={<Button variant="outline" size="sm"><ListTree className="w-4 h-4 mr-2" /> Manage Teams</Button>}
          />
        </div>
        
        {!teams || teams.length === 0 ? (
          <Card className="border-dashed border-2 border-muted bg-transparent">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Trophy className="w-8 h-8 text-muted-foreground mb-4" />
              <h3 className="text-xl font-display font-bold uppercase mb-2">No Teams Yet</h3>
              <p className="text-muted-foreground mb-4">Create a team, then record a game to see it here.</p>
              <div className="flex gap-2">
                <ManageTeamsDialog trigger={<Button variant="outline">Create Team</Button>} />
                <Button asChild>
                  <Link href="/record">Record Game</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Accordion type="multiple" className="space-y-4">
            {teams.map(team => (
              <TeamGamesAccordionItem key={team.teamId} team={team} playerId={playerId} />
            ))}
          </Accordion>
        )}
      </div>
    </div>
  );
}

function PlayerChip({ playerId, name, active, onClick }: { playerId: number, name: string, active: boolean, onClick: () => void }) {
  const { data: summary } = useGetPlayerSummary(playerId, {
    query: { enabled: !!playerId, queryKey: getGetPlayerSummaryQueryKey(playerId) }
  });

  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded font-medium text-sm transition-colors whitespace-nowrap flex items-center gap-2 border ${
        active
          ? "bg-primary text-primary-foreground border-primary shadow-[0_0_16px_hsl(var(--primary)/0.4)]"
          : "bg-muted/60 text-muted-foreground border-border/60 hover:bg-muted"
      }`}
    >
      <span>{name}</span>
      {summary && (
        <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${active ? "bg-secondary-foreground/20" : "bg-foreground/10"}`}>
          {summary.games}GP · {summary.ppg.toFixed(1)}PPG
        </span>
      )}
    </button>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="mb-4 flex items-center gap-3">
      <h2 className="text-xl md:text-2xl font-display font-bold uppercase tracking-wide text-foreground whitespace-nowrap">{title}</h2>
      <div className="h-px flex-1 bg-gradient-to-r from-primary/70 via-primary/20 to-transparent" />
    </div>
  );
}

function HeadlineStat({ label, value, sub, className }: { label: string, value: string | number, sub?: string, className?: string }) {
  return (
    <div className={`px-4 py-5 text-center ${className ?? ""}`}>
      <div className="text-[0.6rem] md:text-xs font-bold text-muted-foreground font-display uppercase tracking-[0.2em]">{label}</div>
      <div className="mt-1 text-3xl md:text-4xl font-display font-bold leading-none text-primary">{value}</div>
      {sub && <div className="mt-1 text-[0.65rem] font-mono uppercase tracking-wide text-muted-foreground">{sub}</div>}
    </div>
  );
}

function StatBox({ label, value, sub }: { label: string, value: string | number, sub?: string }) {
  return (
    <Card className="border-border/60 bg-card/40 overflow-hidden">
      <div className="bg-muted/60 px-4 py-1.5 border-b border-border/60">
        <span className="text-[0.65rem] font-bold text-muted-foreground font-display uppercase tracking-[0.2em]">{label}</span>
      </div>
      <CardContent className="p-4 flex items-end justify-between gap-2">
        <span className="text-3xl font-display font-bold leading-none text-foreground">{value}</span>
        {sub && <span className="text-[0.65rem] font-mono uppercase tracking-wide text-muted-foreground pb-0.5">{sub}</span>}
      </CardContent>
    </Card>
  );
}

function CircularGauge({ value, size = 132, stroke = 11 }: { value: number, size?: number, stroke?: number }) {
  const pctVal = Math.max(0, Math.min(1, value));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pctVal);
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="hsl(var(--muted))" strokeWidth={stroke}
        />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="hsl(var(--primary))" strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 700ms ease-out", filter: "drop-shadow(0 0 6px hsl(var(--primary) / 0.5))" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-display font-bold leading-none text-foreground">{(pctVal * 100).toFixed(1)}</span>
        <span className="text-[0.6rem] font-bold text-muted-foreground uppercase tracking-widest">Percent</span>
      </div>
    </div>
  );
}

function GaugeCard({ label, value, made, attempted }: { label: string, value: number, made: number, attempted: number }) {
  return (
    <Card className="border-border/60 bg-card/40 overflow-hidden">
      <CardContent className="flex flex-col items-center gap-3 p-6">
        <span className="text-xs font-bold text-muted-foreground font-display uppercase tracking-[0.2em]">{label}</span>
        <CircularGauge value={value} />
        <span className="font-mono text-sm text-muted-foreground">
          <span className="text-foreground font-bold">{made}</span> / {attempted}
        </span>
      </CardContent>
    </Card>
  );
}

function pct(made: number, attempted: number) {
  return attempted > 0 ? `${((made / attempted) * 100).toFixed(1)}%` : "—";
}

function TeamFormDialog({ trigger, team, onSaved }: { trigger: React.ReactNode, team?: { id: number, name: string }, onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team?.name || "");
  const createTeam = useCreateTeam();
  const updateTeam = useUpdateTeam();
  const { toast } = useToast();

  const handleSave = async () => {
    if (!name.trim()) return;
    try {
      if (team) {
        await updateTeam.mutateAsync({ teamId: team.id, data: { name: name.trim() } });
        toast({ title: "Team updated" });
      } else {
        await createTeam.mutateAsync({ data: { name: name.trim() } });
        toast({ title: "Team added" });
      }
      setOpen(false);
      setName(team ? name : "");
      onSaved();
    } catch (err) {
      const description = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : undefined;
      toast({ title: "Error saving team", description, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) setName(team?.name || ""); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display uppercase text-2xl">{team ? "Edit Team" : "Add Team / Season"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Team / Season Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Travel 24-25'" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || createTeam.isPending || updateTeam.isPending}>
            {(createTeam.isPending || updateTeam.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />} Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageTeamsDialog({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { data: teams, isLoading } = useListTeams();
  const deleteTeam = useDeleteTeam();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
    queryClient.invalidateQueries({
      predicate: (query) =>
        typeof query.queryKey[0] === "string" &&
        /^\/api\/players\/\d+\/teams$/.test(query.queryKey[0] as string),
    });
  };

  const handleDelete = async (teamId: number) => {
    if (!confirm("Delete this team? This will also delete all games recorded for it.")) return;
    try {
      await deleteTeam.mutateAsync({ teamId });
      toast({ title: "Team deleted" });
      invalidateAll();
    } catch (err) {
      toast({ title: "Error deleting team", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display uppercase text-2xl">Manage Teams / Seasons</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <TeamFormDialog
            trigger={<Button className="w-full"><Plus className="w-4 h-4 mr-2" /> Add Team / Season</Button>}
            onSaved={invalidateAll}
          />
          <div className="max-h-80 overflow-y-auto space-y-2">
            {isLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin" /></div>
            ) : !teams || teams.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-6">No teams yet. Add one above.</p>
            ) : (
              teams.map(t => (
                <div key={t.id} className="flex items-center justify-between border rounded-md px-3 py-2">
                  <span className="font-medium">{t.name}</span>
                  <div className="flex gap-1">
                    <TeamFormDialog
                      team={{ id: t.id, name: t.name }}
                      trigger={<Button variant="ghost" size="icon" aria-label={`Edit ${t.name}`}><Edit className="w-4 h-4" /></Button>}
                      onSaved={invalidateAll}
                    />
                    <Button variant="ghost" size="icon" aria-label={`Delete ${t.name}`} onClick={() => handleDelete(t.id)}>
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TeamGamesAccordionItem({ team, playerId }: { team: any, playerId: number }) {
  const { data: games, isLoading } = useListTeamGames(team.teamId, {
    query: { enabled: !!team.teamId, queryKey: getListTeamGamesQueryKey(team.teamId) }
  });

  const deleteGame = useDeleteGame();
  const deleteTeam = useDeleteTeam();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDeleteGame = async (gameId: number) => {
    if (!confirm("Delete this game?")) return;
    try {
      await deleteGame.mutateAsync({ gameId });
      queryClient.invalidateQueries({ queryKey: getListTeamGamesQueryKey(team.teamId) });
      queryClient.invalidateQueries({ queryKey: getGetPlayerSummaryQueryKey(playerId) });
      queryClient.invalidateQueries({ queryKey: getListPlayerTeamGroupsQueryKey(playerId) });
      toast({ title: "Game deleted" });
    } catch(err) {
      toast({ title: "Error deleting game", variant: "destructive" });
    }
  };

  const invalidateTeamQueries = () => {
    queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListPlayerTeamGroupsQueryKey(playerId) });
  };

  const handleDeleteTeam = async () => {
    if (!confirm(`Delete "${team.teamName}"? This also deletes all of its games and stats.`)) return;
    try {
      await deleteTeam.mutateAsync({ teamId: team.teamId });
      invalidateTeamQueries();
      toast({ title: "Team deleted" });
    } catch (err) {
      toast({ title: "Error deleting team", variant: "destructive" });
    }
  };

  const playerGames = games?.filter(g => g.stats.some(s => s.playerId === playerId)) || [];

  return (
    <AccordionItem value={team.teamId.toString()} className="border rounded-lg bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 hover:bg-muted/50 data-[state=open]:bg-muted/50 transition-colors">
        <AccordionTrigger className="py-3 hover:no-underline flex-1">
          <div className="flex items-center gap-4">
            <h3 className="font-display font-bold text-xl uppercase">{team.teamName}</h3>
            <div className="flex gap-2 text-sm">
              <span className="px-2 py-0.5 rounded bg-primary/10 text-primary font-bold">
                {team.wins} - {team.losses}
              </span>
              <span className="px-2 py-0.5 rounded bg-muted-foreground/10 text-muted-foreground font-medium">
                {team.games} GP
              </span>
            </div>
          </div>
        </AccordionTrigger>
        <div className="flex items-center gap-1 pl-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/record?teamId=${team.teamId}`}><Plus className="w-4 h-4 mr-1" /> Game</Link>
          </Button>
          <TeamFormDialog
            team={{ id: team.teamId, name: team.teamName }}
            trigger={<Button variant="ghost" size="icon" className="h-8 w-8"><Edit className="h-4 w-4" /></Button>}
            onSaved={invalidateTeamQueries}
          />
          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={handleDeleteTeam}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <AccordionContent className="p-0 border-t">
        {isLoading ? (
          <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : playerGames.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground">No games found for this player on this team.</div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-[120px]">Date</TableHead>
                  <TableHead>Opponent</TableHead>
                  <TableHead>Result</TableHead>
                  <TableHead className="text-right">FT</TableHead>
                  <TableHead className="text-right">FT%</TableHead>
                  <TableHead className="text-right">2P</TableHead>
                  <TableHead className="text-right">3P</TableHead>
                  <TableHead className="text-right">FG%</TableHead>
                  <TableHead className="text-right">3P%</TableHead>
                  <TableHead className="text-right">PTS</TableHead>
                  <TableHead className="text-right">AST</TableHead>
                  <TableHead className="text-right">REB</TableHead>
                  <TableHead className="text-right">STL</TableHead>
                  <TableHead className="text-right">TO</TableHead>
                  <TableHead className="text-right">BLK</TableHead>
                  <TableHead className="w-[100px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {playerGames.map(game => {
                  const stat = game.stats.find(s => s.playerId === playerId);
                  if (!stat) return null;

                  const fgMade = stat.twoMade + stat.threeMade;
                  const fgAttempted = stat.twoAttempted + stat.threeAttempted;

                  return (
                    <TableRow key={game.id} className="group">
                      <TableCell className="font-mono text-xs">{new Date(game.date).toLocaleDateString()}</TableCell>
                      <TableCell className="font-medium">{game.opponent}</TableCell>
                      <TableCell>
                        <span className={`font-bold ${game.result === 'W' ? 'text-green-600' : 'text-red-600'}`}>
                          {game.result}
                        </span>
                        <span className="text-muted-foreground text-xs ml-2">
                          {game.teamScore}-{game.opponentScore}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {stat.ftMade}/{stat.ftAttempted}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {pct(stat.ftMade, stat.ftAttempted)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {stat.twoMade}/{stat.twoAttempted}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {stat.threeMade}/{stat.threeAttempted}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {pct(fgMade, fgAttempted)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {pct(stat.threeMade, stat.threeAttempted)}
                      </TableCell>
                      <TableCell className="text-right font-bold text-primary">{stat.points}</TableCell>
                      <TableCell className="text-right">{stat.assists}</TableCell>
                      <TableCell className="text-right">{stat.rebounds}</TableCell>
                      <TableCell className="text-right">{stat.steals}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{stat.turnovers}</TableCell>
                      <TableCell className="text-right">{stat.blocks}</TableCell>
                      <TableCell className="text-right opacity-100 md:opacity-60 md:group-hover:opacity-100 transition-opacity">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
                            <Link href={`/record/${game.id}`}><Edit className="h-4 w-4" /></Link>
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => handleDeleteGame(game.id)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </AccordionContent>
    </AccordionItem>
  );
}
