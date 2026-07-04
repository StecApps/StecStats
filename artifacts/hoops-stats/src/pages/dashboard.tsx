import { useState } from "react";
import { 
  useListPlayers, 
  useCreatePlayer, 
  useUpdatePlayer, 
  useDeletePlayer,
  useGetPlayerSummary,
  useListPlayerTeamGroups,
  useListTeamGames,
  useCreateTeam,
  useDeleteGame,
  getListPlayersQueryKey,
  getGetPlayerSummaryQueryKey,
  getListPlayerTeamGroupsQueryKey,
  getListTeamGamesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Settings, Trash2, Edit, ChevronDown, Trophy, Activity, CalendarDays } from "lucide-react";
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
      toast({ title: "Error", description: "Failed to add player", variant: "destructive" });
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

      {players && players.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {players.map(p => (
            <button
              key={p.id}
              onClick={() => setSelectedPlayerId(p.id)}
              className={`px-4 py-2 rounded font-medium text-sm transition-colors whitespace-nowrap ${
                activePlayerId === p.id 
                  ? "bg-secondary text-secondary-foreground" 
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {p.name}
            </button>
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

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <div className="flex justify-between items-end mb-4 border-b-2 border-secondary/10 pb-2">
          <h2 className="text-2xl font-display font-bold uppercase text-secondary">Career Averages</h2>
          
          <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8">
                <Settings className="w-4 h-4 mr-2" /> Manage Player
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

        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4">
          <StatBox label="PTS" value={summary.ppg.toFixed(1)} />
          <StatBox label="REB" value={summary.rpg.toFixed(1)} />
          <StatBox label="AST" value={summary.apg.toFixed(1)} />
          <StatBox label="STL" value={summary.spg.toFixed(1)} />
          <StatBox label="BLK" value={summary.bpg.toFixed(1)} />
          <StatBox label="FG%" value={`${(summary.fgPct * 100).toFixed(1)}%`} />
          <StatBox label="3P%" value={`${(summary.threePct * 100).toFixed(1)}%`} />
          <StatBox label="FT%" value={`${(summary.ftPct * 100).toFixed(1)}%`} />
        </div>
      </div>
      
      <div className="mt-8">
        <h2 className="text-2xl font-display font-bold uppercase mb-4 text-secondary border-b-2 border-secondary/10 pb-2">Teams & Seasons</h2>
        
        {!teams || teams.length === 0 ? (
          <Card className="border-dashed border-2 border-muted bg-transparent">
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Trophy className="w-8 h-8 text-muted-foreground mb-4" />
              <h3 className="text-xl font-display font-bold uppercase mb-2">No Teams Yet</h3>
              <p className="text-muted-foreground mb-4">Record a game for this player to see team history.</p>
              <Button asChild>
                <Link href="/record">Record Game</Link>
              </Button>
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

function StatBox({ label, value }: { label: string, value: string | number }) {
  return (
    <Card className="border-secondary/10 shadow-sm overflow-hidden">
      <div className="bg-muted px-4 py-1 border-b border-secondary/10">
        <span className="text-xs font-bold text-muted-foreground font-display uppercase tracking-widest">{label}</span>
      </div>
      <CardContent className="p-4 flex items-end justify-between">
        <span className="text-3xl font-display font-bold leading-none text-secondary">{value}</span>
      </CardContent>
    </Card>
  );
}

function TeamGamesAccordionItem({ team, playerId }: { team: any, playerId: number }) {
  const { data: games, isLoading } = useListTeamGames(team.teamId, {
    query: { enabled: !!team.teamId, queryKey: getListTeamGamesQueryKey(team.teamId) }
  });

  const deleteGame = useDeleteGame();
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

  const playerGames = games?.filter(g => g.stats.some(s => s.playerId === playerId)) || [];

  return (
    <AccordionItem value={team.teamId.toString()} className="border rounded-lg bg-card overflow-hidden">
      <AccordionTrigger className="px-4 py-3 hover:bg-muted/50 data-[state=open]:bg-muted/50 transition-colors">
        <div className="flex items-center justify-between w-full pr-4">
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
        </div>
      </AccordionTrigger>
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
                  <TableHead className="text-right">PTS</TableHead>
                  <TableHead className="text-right">REB</TableHead>
                  <TableHead className="text-right">AST</TableHead>
                  <TableHead className="text-right">STL</TableHead>
                  <TableHead className="text-right">BLK</TableHead>
                  <TableHead className="text-right">TO</TableHead>
                  <TableHead className="text-right">FG</TableHead>
                  <TableHead className="text-right">3PT</TableHead>
                  <TableHead className="text-right">FT</TableHead>
                  <TableHead className="w-[100px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {playerGames.map(game => {
                  const stat = game.stats.find(s => s.playerId === playerId);
                  if (!stat) return null;
                  
                  const fgm = stat.twoMade + stat.threeMade;
                  const fga = stat.twoAttempted + stat.threeAttempted;
                  
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
                      <TableCell className="text-right font-bold text-primary">{stat.points}</TableCell>
                      <TableCell className="text-right">{stat.rebounds}</TableCell>
                      <TableCell className="text-right">{stat.assists}</TableCell>
                      <TableCell className="text-right">{stat.steals}</TableCell>
                      <TableCell className="text-right">{stat.blocks}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{stat.turnovers}</TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {fgm}/{fga}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {stat.threeMade}/{stat.threeAttempted}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {stat.ftMade}/{stat.ftAttempted}
                      </TableCell>
                      <TableCell className="text-right opacity-0 group-hover:opacity-100 transition-opacity">
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
