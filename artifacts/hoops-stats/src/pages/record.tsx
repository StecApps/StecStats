import { useState, useEffect } from "react";
import { 
  useListPlayers, 
  useListTeams,
  useCreateGame,
  useUpdateGame,
  useGetGame,
  useCreateTeam,
  useCreatePlayer,
  getGetGameQueryKey,
  getGetPlayerSummaryQueryKey,
  getListPlayerTeamGroupsQueryKey,
  getListTeamGamesQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Plus, ArrowLeft, Minus, UserPlus, Check, X, CalendarDays } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";

type StatCounters = {
  playerId: number;
  ftMade: number;
  ftAttempted: number;
  twoMade: number;
  twoAttempted: number;
  threeMade: number;
  threeAttempted: number;
  assists: number;
  rebounds: number;
  steals: number;
  turnovers: number;
  blocks: number;
};

const initialStats = (playerId: number): StatCounters => ({
  playerId, ftMade: 0, ftAttempted: 0, twoMade: 0, twoAttempted: 0, threeMade: 0, threeAttempted: 0, assists: 0, rebounds: 0, steals: 0, turnovers: 0, blocks: 0
});

export default function RecordGame() {
  const params = useParams();
  const search = useSearch();
  const gameId = params.id ? parseInt(params.id, 10) : undefined;
  const isEditing = !!gameId;
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const preselectedTeamId = new URLSearchParams(search).get("teamId") || "";

  const { data: gameToEdit, isLoading: gameLoading } = useGetGame(gameId as number, {
    query: { enabled: isEditing, queryKey: getGetGameQueryKey(gameId as number) }
  });

  const { data: players } = useListPlayers();
  const { data: teams, refetch: refetchTeams } = useListTeams();
  const createTeam = useCreateTeam();
  const createPlayer = useCreatePlayer();
  const createGame = useCreateGame();
  const updateGame = useUpdateGame();

  const [teamId, setTeamId] = useState<string>(preselectedTeamId);
  const [opponent, setOpponent] = useState("");
  const [date, setDate] = useState<Date>(new Date());
  const [teamScore, setTeamScore] = useState<number>(0);
  const [opponentScore, setOpponentScore] = useState<number>(0);
  
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<number[]>([]);
  const [stats, setStats] = useState<Record<number, StatCounters>>({});

  const [newTeamName, setNewTeamName] = useState("");
  const [isAddTeamOpen, setIsAddTeamOpen] = useState(false);

  const [newPlayerName, setNewPlayerName] = useState("");
  const [isAddPlayerOpen, setIsAddPlayerOpen] = useState(false);

  useEffect(() => {
    if (isEditing && gameToEdit) {
      setTeamId(gameToEdit.teamId.toString());
      setOpponent(gameToEdit.opponent);
      setDate(new Date(gameToEdit.date));
      setTeamScore(gameToEdit.teamScore);
      setOpponentScore(gameToEdit.opponentScore);
      
      const ids = gameToEdit.stats.map(s => s.playerId);
      setSelectedPlayerIds(ids);
      
      const statsObj: Record<number, StatCounters> = {};
      gameToEdit.stats.forEach(s => {
        statsObj[s.playerId] = {
          playerId: s.playerId,
          ftMade: s.ftMade, ftAttempted: s.ftAttempted,
          twoMade: s.twoMade, twoAttempted: s.twoAttempted,
          threeMade: s.threeMade, threeAttempted: s.threeAttempted,
          assists: s.assists, rebounds: s.rebounds,
          steals: s.steals, turnovers: s.turnovers, blocks: s.blocks
        };
      });
      setStats(statsObj);
    }
  }, [isEditing, gameToEdit]);

  const handleTogglePlayer = (pid: number) => {
    if (selectedPlayerIds.includes(pid)) {
      setSelectedPlayerIds(prev => prev.filter(id => id !== pid));
      setStats(prev => {
        const next = { ...prev };
        delete next[pid];
        return next;
      });
    } else {
      setSelectedPlayerIds(prev => [...prev, pid]);
      setStats(prev => ({ ...prev, [pid]: initialStats(pid) }));
    }
  };

  const updateStat = (pid: number, field: keyof StatCounters, increment: number) => {
    setStats(prev => {
      const pStats = prev[pid] || initialStats(pid);
      const nextVal = Math.max(0, pStats[field] + increment);
      
      let updates: Partial<StatCounters> = { [field]: nextVal };
      
      if (increment > 0) {
        if (field === 'twoMade') updates.twoAttempted = pStats.twoAttempted + 1;
        if (field === 'threeMade') updates.threeAttempted = pStats.threeAttempted + 1;
        if (field === 'ftMade') updates.ftAttempted = pStats.ftAttempted + 1;
      }
      
      return { ...prev, [pid]: { ...pStats, ...updates } };
    });
  };

  const handleSave = async () => {
    if (!teamId || !opponent || !date || selectedPlayerIds.length === 0) {
      toast({ title: "Incomplete", description: "Select team, opponent, date, and at least one player.", variant: "destructive" });
      return;
    }

    const isWin = teamScore > opponentScore;
    const isTie = teamScore === opponentScore;
    const result = isWin ? 'W' : 'L'; // Backend requires W or L

    const payload = {
      teamId: parseInt(teamId, 10),
      opponent,
      date: date.toISOString().split('T')[0],
      result: result as 'W' | 'L',
      teamScore,
      opponentScore,
      stats: Object.values(stats)
    };

    try {
      if (isEditing) {
        await updateGame.mutateAsync({ gameId: gameId as number, data: payload });
        toast({ title: "Game updated" });
      } else {
        await createGame.mutateAsync({ data: payload });
        toast({ title: "Game recorded" });
      }
      
      selectedPlayerIds.forEach(pid => {
        queryClient.invalidateQueries({ queryKey: getGetPlayerSummaryQueryKey(pid) });
        queryClient.invalidateQueries({ queryKey: getListPlayerTeamGroupsQueryKey(pid) });
      });
      queryClient.invalidateQueries({ queryKey: getListTeamGamesQueryKey(parseInt(teamId, 10)) });
      
      navigate("/");
    } catch(err) {
      toast({ title: "Error saving game", variant: "destructive" });
    }
  };

  const handleCreateTeam = async () => {
    if (!newTeamName) return;
    try {
      const t = await createTeam.mutateAsync({ data: { name: newTeamName } });
      await refetchTeams();
      setTeamId(t.id.toString());
      setIsAddTeamOpen(false);
      setNewTeamName("");
    } catch(err) {}
  };

  const handleCreatePlayer = async () => {
    if (!newPlayerName) return;
    try {
      const p = await createPlayer.mutateAsync({ data: { name: newPlayerName } });
      queryClient.invalidateQueries(); // refetch players
      handleTogglePlayer(p.id);
      setIsAddPlayerOpen(false);
      setNewPlayerName("");
    } catch(err) {}
  };

  if (isEditing && gameLoading) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin" /></div>;
  }

  return (
    <div className="flex flex-col space-y-6 pb-24">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")}><ArrowLeft className="w-5 h-5" /></Button>
        <h1 className="text-4xl font-display font-bold uppercase tracking-tight text-secondary">
          {isEditing ? "Edit Game" : "Record Game"}
        </h1>
      </div>

      <Card className="border-secondary/10">
        <CardContent className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <div className="space-y-2">
            <Label>Team / Season</Label>
            <div className="flex gap-2">
              <Select value={teamId} onValueChange={setTeamId}>
                <SelectTrigger className="flex-1"><SelectValue placeholder="Select team" /></SelectTrigger>
                <SelectContent>
                  {teams?.map(t => <SelectItem key={t.id} value={t.id.toString()}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Dialog open={isAddTeamOpen} onOpenChange={setIsAddTeamOpen}>
                <DialogTrigger asChild><Button variant="outline" size="icon"><Plus className="w-4 h-4" /></Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader><DialogTitle>New Team/Season</DialogTitle></DialogHeader>
                  <Input value={newTeamName} onChange={e => setNewTeamName(e.target.value)} placeholder="e.g. 2024 Summer League" />
                  <DialogFooter><Button onClick={handleCreateTeam}>Add</Button></DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
          
          <div className="space-y-2">
            <Label>Opponent</Label>
            <Input value={opponent} onChange={e => setOpponent(e.target.value)} placeholder="Opponent team name" />
          </div>

          <div className="space-y-2">
            <Label>Date</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="w-full justify-start text-left font-normal">
                  <CalendarDays className="mr-2 h-4 w-4" />
                  {date ? format(date, "PPP") : <span>Pick a date</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar mode="single" selected={date} onSelect={(d) => d && setDate(d)} initialFocus />
              </PopoverContent>
            </Popover>
          </div>

          <div className="space-y-2">
            <Label>Final Score (Us - Them)</Label>
            <div className="flex items-center gap-2">
              <Input type="number" value={teamScore || ''} onChange={e => setTeamScore(parseInt(e.target.value) || 0)} className="text-center font-bold font-mono text-lg text-primary bg-primary/5" />
              <span className="font-bold text-xl">-</span>
              <Input type="number" value={opponentScore || ''} onChange={e => setOpponentScore(parseInt(e.target.value) || 0)} className="text-center font-bold font-mono text-lg" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-display font-bold uppercase text-secondary">Roster</h2>
          <Dialog open={isAddPlayerOpen} onOpenChange={setIsAddPlayerOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="h-8"><UserPlus className="w-4 h-4 mr-2"/> New Player</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>New Player</DialogTitle></DialogHeader>
              <Input value={newPlayerName} onChange={e => setNewPlayerName(e.target.value)} placeholder="Player Name" />
              <DialogFooter><Button onClick={handleCreatePlayer}>Add</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        
        <div className="flex flex-wrap gap-2">
          {players?.map(p => {
            const isSelected = selectedPlayerIds.includes(p.id);
            return (
              <Button
                key={p.id}
                variant={isSelected ? "default" : "outline"}
                className={`rounded-full ${isSelected ? 'shadow-md shadow-primary/20' : ''}`}
                onClick={() => handleTogglePlayer(p.id)}
              >
                {isSelected && <Check className="w-4 h-4 mr-2" />}
                {p.name}
              </Button>
            );
          })}
        </div>
      </div>

      <div className="space-y-6">
        {selectedPlayerIds.map(pid => {
          const player = players?.find(p => p.id === pid);
          const s = stats[pid] || initialStats(pid);
          const pts = (s.twoMade * 2) + (s.threeMade * 3) + s.ftMade;
          
          return (
            <Card key={pid} className="border-secondary/20 shadow-md overflow-hidden">
              <div className="bg-secondary text-secondary-foreground px-4 py-2 flex justify-between items-center">
                <h3 className="font-display font-bold text-xl uppercase tracking-wide">{player?.name}</h3>
                <div className="font-display font-bold text-2xl text-primary">{pts} PTS</div>
              </div>
              <CardContent className="p-4 grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-4 bg-card">
                <StatCounter label="2PT" made={s.twoMade} attempt={s.twoAttempted} 
                  onMake={() => updateStat(pid, 'twoMade', 1)} onMiss={() => updateStat(pid, 'twoAttempted', 1)} 
                  onUndoMake={() => updateStat(pid, 'twoMade', -1)} onUndoMiss={() => updateStat(pid, 'twoAttempted', -1)} />
                <StatCounter label="3PT" made={s.threeMade} attempt={s.threeAttempted} 
                  onMake={() => updateStat(pid, 'threeMade', 1)} onMiss={() => updateStat(pid, 'threeAttempted', 1)}
                  onUndoMake={() => updateStat(pid, 'threeMade', -1)} onUndoMiss={() => updateStat(pid, 'threeAttempted', -1)} />
                <StatCounter label="FT" made={s.ftMade} attempt={s.ftAttempted} 
                  onMake={() => updateStat(pid, 'ftMade', 1)} onMiss={() => updateStat(pid, 'ftAttempted', 1)}
                  onUndoMake={() => updateStat(pid, 'ftMade', -1)} onUndoMiss={() => updateStat(pid, 'ftAttempted', -1)} />
                
                <SingleStatCounter label="REB" value={s.rebounds} onInc={() => updateStat(pid, 'rebounds', 1)} onDec={() => updateStat(pid, 'rebounds', -1)} />
                <SingleStatCounter label="AST" value={s.assists} onInc={() => updateStat(pid, 'assists', 1)} onDec={() => updateStat(pid, 'assists', -1)} />
                <SingleStatCounter label="STL" value={s.steals} onInc={() => updateStat(pid, 'steals', 1)} onDec={() => updateStat(pid, 'steals', -1)} />
                <SingleStatCounter label="BLK" value={s.blocks} onInc={() => updateStat(pid, 'blocks', 1)} onDec={() => updateStat(pid, 'blocks', -1)} />
                <SingleStatCounter label="TO" value={s.turnovers} onInc={() => updateStat(pid, 'turnovers', 1)} onDec={() => updateStat(pid, 'turnovers', -1)} />
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-background/80 backdrop-blur-md border-t z-40 pb-safe shadow-[0_-10px_40px_rgba(0,0,0,0.1)]">
        <div className="container max-w-screen-2xl mx-auto flex justify-between items-center">
          <div className="font-display font-bold text-2xl uppercase">
            <span className="text-primary">{teamScore}</span>
            <span className="mx-2 text-muted-foreground">-</span>
            <span>{opponentScore}</span>
          </div>
          <Button size="lg" className="font-display text-xl uppercase tracking-wider px-12 h-14" onClick={handleSave} disabled={createGame.isPending || updateGame.isPending}>
            {(createGame.isPending || updateGame.isPending) && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
            Save Game
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatCounter({ label, made, attempt, onMake, onMiss, onUndoMake, onUndoMiss }: any) {
  return (
    <div className="flex flex-col border rounded-lg overflow-hidden bg-muted/20">
      <div className="bg-muted text-center py-1 text-xs font-bold tracking-widest text-muted-foreground">{label}</div>
      <div className="flex-1 flex flex-col items-center justify-center p-2 gap-1">
        <div className="font-mono text-xl font-bold tracking-tighter">
          <span className="text-primary">{made}</span><span className="text-muted-foreground/50">/</span><span>{attempt}</span>
        </div>
      </div>
      <div className="grid grid-cols-2 divide-x border-t">
        <Button variant="ghost" className="rounded-none h-12 hover:bg-green-500/10 hover:text-green-600 active:bg-green-500/20" onClick={onMake} onContextMenu={(e) => { e.preventDefault(); onUndoMake(); }}>
          MAKE
        </Button>
        <Button variant="ghost" className="rounded-none h-12 hover:bg-red-500/10 hover:text-red-600 active:bg-red-500/20" onClick={onMiss} onContextMenu={(e) => { e.preventDefault(); onUndoMiss(); }}>
          MISS
        </Button>
      </div>
    </div>
  );
}

function SingleStatCounter({ label, value, onInc, onDec }: any) {
  return (
    <div className="flex flex-col border rounded-lg overflow-hidden bg-muted/20">
      <div className="bg-muted text-center py-1 text-xs font-bold tracking-widest text-muted-foreground">{label}</div>
      <div className="flex-1 flex items-center justify-center p-2">
        <div className="font-mono text-2xl font-bold">{value}</div>
      </div>
      <div className="grid grid-cols-2 divide-x border-t">
        <Button variant="ghost" className="rounded-none h-12 active:bg-muted" onClick={onDec}>-</Button>
        <Button variant="ghost" className="rounded-none h-12 active:bg-muted" onClick={onInc}>+</Button>
      </div>
    </div>
  );
}
