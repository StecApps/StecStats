import { useState, useRef, useEffect, useCallback } from "react";
import { GameStatCard } from "@/components/GameStatCard";
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
  useMergeGames,
  useGetTeamHighlight,
  useGenerateTeamHighlight,
  useGenerateGameHighlight,
  useGetBillingStatus,
  useUpdateGame,
  getListPlayersQueryKey,
  getGetPlayerSummaryQueryKey,
  getListPlayerTeamGroupsQueryKey,
  getListTeamGamesQueryKey,
  getListTeamsQueryKey,
  getGetTeamHighlightQueryKey,
  type Game,
  type PlayerGameStatLine,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Plus, Settings, Trash2, Edit, ChevronDown, Trophy, Activity, CalendarDays, ListTree, Zap, Lock, Sparkles, Share2, Download, Film, Camera, AlertTriangle, UserCircle2, ImagePlus, Video, Check, GitMerge, Square, SquareCheck, Pencil, Minus } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation } from "wouter";

function videoObjectSrc(objectPath: string): string {
  return `/api/storage/objects/${objectPath.replace(/^\/objects\//, "")}`;
}

function playerPhotoSrc(objectPath: string): string {
  return `/api/storage/objects/${objectPath.replace(/^\/objects\//, "")}`;
}

function isPhotoStale(photoUpdatedAt: Date | string | null | undefined): boolean {
  if (!photoUpdatedAt) return false;
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  return new Date(photoUpdatedAt) < sixMonthsAgo;
}

async function uploadPhoto(file: File): Promise<string> {
  const requestRes = await fetch("/api/storage/uploads/request-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "image/jpeg" }),
  });
  if (!requestRes.ok) throw new Error("Failed to get upload URL");
  const { uploadURL, objectPath } = await requestRes.json();
  const uploadRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type || "image/jpeg" },
    body: file,
  });
  if (!uploadRes.ok) throw new Error("Failed to upload photo");
  return objectPath;
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: players, isLoading: playersLoading } = useListPlayers();
  const { data: billingStatus } = useGetBillingStatus();
  const isPro = billingStatus?.plan === "pro" || billingStatus?.plan === "premium";
  const isPremium = billingStatus?.plan === "premium";
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const [isAddPlayerOpen, setIsAddPlayerOpen] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState("");

  const createPlayer = useCreatePlayer();
  const deletePlayer = useDeletePlayer();

  const handleDeletePlayer = async (playerId: number, playerName: string) => {
    if (!confirm(`Remove ${playerName}? This will permanently delete all their stats.`)) return;
    try {
      await deletePlayer.mutateAsync({ playerId });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      if (selectedPlayerId === playerId) setSelectedPlayerId(null);
      toast({ title: "Player removed", description: `${playerName} has been removed from the roster.` });
    } catch (err) {
      toast({ title: "Error removing player", variant: "destructive" });
    }
  };

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
    <div className="flex flex-col space-y-6 pb-20 md:pb-0">
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
              onDelete={() => handleDeletePlayer(p.id, p.name)}
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
        <PlayerDashboard playerId={activePlayerId} player={players?.find(p => p.id === activePlayerId)} isPro={isPro} isPremium={isPremium} />
      )}
    </div>
  );
}

type PlayerWithPhoto = { id: number; name: string; photoObjectPath?: string | null; photoUpdatedAt?: Date | string | null };

function PlayerDashboard({ playerId, player, isPro, isPremium }: { playerId: number, player?: PlayerWithPhoto, isPro: boolean, isPremium: boolean }) {
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
  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [selectedTeamIds, setSelectedTeamIds] = useState<number[]>([]);
  const toggleTeamSelection = useCallback((teamId: number) => {
    setSelectedTeamIds(prev =>
      prev.includes(teamId) ? prev.filter(id => id !== teamId) : [...prev, teamId]
    );
  }, []);

  const photoStale = isPhotoStale(player?.photoUpdatedAt);

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

  const handlePhotoFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsUploadingPhoto(true);
    try {
      const objectPath = await uploadPhoto(file);
      await updatePlayer.mutateAsync({ playerId, data: { photoObjectPath: objectPath } });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      toast({ title: "Photo saved", description: "Player photo updated for tracking." });
    } catch (err) {
      toast({ title: "Failed to upload photo", variant: "destructive" });
    } finally {
      setIsUploadingPhoto(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  const handleRemovePhoto = async () => {
    try {
      await updatePlayer.mutateAsync({ playerId, data: { photoObjectPath: null } });
      queryClient.invalidateQueries({ queryKey: getListPlayersQueryKey() });
      toast({ title: "Photo removed" });
    } catch (err) {
      toast({ title: "Failed to remove photo", variant: "destructive" });
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
          {/* Player tracking photo avatar — tappable for Premium users */}
          {isPremium ? (
            player?.photoObjectPath ? (
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={isUploadingPhoto}
                className="mt-4 relative group focus:outline-none"
                title={photoStale ? "Photo over 6 months old — tap to update" : "Tap to update photo"}
              >
                <img
                  src={playerPhotoSrc(player.photoObjectPath)}
                  alt={player.name}
                  className="w-24 h-24 rounded-full object-cover border-4 border-primary/40 shadow-lg"
                />
                <div className="absolute inset-0 rounded-full bg-black/55 opacity-0 group-hover:opacity-100 group-focus:opacity-100 flex items-center justify-center transition-opacity">
                  {isUploadingPhoto
                    ? <Loader2 className="w-6 h-6 text-white animate-spin" />
                    : <Camera className="w-6 h-6 text-white" />}
                </div>
                {photoStale && (
                  <span className="absolute -bottom-1 -right-1 bg-yellow-500 rounded-full p-1" title="Photo over 6 months old">
                    <AlertTriangle className="w-3.5 h-3.5 text-black" />
                  </span>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={isUploadingPhoto}
                className="mt-4 w-24 h-24 rounded-full border-2 border-dashed border-primary/50 bg-primary/5 flex flex-col items-center justify-center gap-1 hover:bg-primary/10 focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
                title="Add a tracking photo for automatic player follow"
              >
                {isUploadingPhoto
                  ? <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  : <Camera className="w-6 h-6 text-primary" />}
                <span className="text-[0.6rem] font-bold uppercase tracking-wider text-primary leading-none">Add Photo</span>
              </button>
            )
          ) : player?.photoObjectPath ? (
            <div className="mt-4 relative">
              <img
                src={playerPhotoSrc(player.photoObjectPath)}
                alt={player.name}
                className="w-24 h-24 rounded-full object-cover border-4 border-primary/40 shadow-lg"
              />
            </div>
          ) : null}
          <h1 className="mt-3 font-display font-bold uppercase leading-[0.85] tracking-tight text-6xl md:text-8xl text-jumbotron break-words max-w-full">
            {player?.name ?? "Player"}
          </h1>
          <div className="mt-5 flex items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background/60 px-4 py-1.5 text-[0.65rem] font-bold uppercase tracking-[0.25em] text-muted-foreground">
              <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              {summary.seasonScope === "career" ? "Career Summary Dashboard" : "Current Season Summary"}
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
                <div className="space-y-5 py-4">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input value={editName} onChange={e => setEditName(e.target.value)} />
                  </div>

                  {/* Tracking photo — Premium feature */}
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label>Tracking Photo</Label>
                      {!isPremium && (
                        <span className="text-[0.65rem] font-bold uppercase tracking-wider text-primary border border-primary/40 rounded-full px-2 py-0.5">Premium</span>
                      )}
                    </div>
                    {isPremium ? (
                      <div className="flex items-center gap-4">
                        {player?.photoObjectPath ? (
                          <img
                            src={playerPhotoSrc(player.photoObjectPath)}
                            alt="Player tracking photo"
                            className="w-16 h-16 rounded-full object-cover border-2 border-border"
                          />
                        ) : (
                          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center border-2 border-dashed border-border">
                            <UserCircle2 className="w-8 h-8 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex flex-col gap-2">
                          <input
                            ref={photoInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={handlePhotoFileSelected}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={isUploadingPhoto}
                            onClick={() => photoInputRef.current?.click()}
                          >
                            {isUploadingPhoto ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ImagePlus className="w-4 h-4 mr-2" />}
                            {player?.photoObjectPath ? "Change Photo" : "Upload Photo"}
                          </Button>
                          {player?.photoObjectPath && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground"
                              onClick={handleRemovePhoto}
                            >
                              <Trash2 className="w-4 h-4 mr-2" /> Remove
                            </Button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3">
                        <Lock className="w-5 h-5 text-primary shrink-0" />
                        <div className="text-sm">
                          <span className="text-muted-foreground">Save a photo of your player for automatic tracking during games. </span>
                          <Link href="/billing" className="text-primary underline font-medium">Upgrade to Premium</Link>
                        </div>
                      </div>
                    )}
                    {isPremium && photoStale && player?.photoObjectPath && (
                      <p className="text-xs text-yellow-500 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" /> Photo is over 6 months old — consider updating before your next game.
                      </p>
                    )}
                    {isPremium && !player?.photoObjectPath && (
                      <p className="text-xs text-muted-foreground">
                        A clear recent photo ensures the best tracking accuracy. The app uses this to automatically follow your player during recording.
                      </p>
                    )}
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

      {/* SHOOTING EFFICIENCY (Pro-only) */}
      <div>
        <SectionHeader title="Shooting Efficiency" />
        {isPro ? (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <GaugeCard label="Field Goal" value={summary.fgPct ?? 0} made={summary.twoMade + summary.threeMade} attempted={summary.twoAttempted + summary.threeAttempted} />
            <GaugeCard label="3-Point" value={summary.threePct ?? 0} made={summary.threeMade} attempted={summary.threeAttempted} />
            <GaugeCard label="Free Throw" value={summary.ftPct ?? 0} made={summary.ftMade} attempted={summary.ftAttempted} />
          </div>
        ) : (
          <Card className="border-dashed border-2 border-muted bg-transparent">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center gap-3">
              <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
                <Lock className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-display font-bold uppercase">Shooting Gauges are a Pro Feature</h3>
                <p className="text-muted-foreground text-sm">Upgrade to Pro to unlock FG%, 3PT%, and FT% efficiency gauges.</p>
              </div>
              <Button asChild size="sm">
                <Link href="/billing">Upgrade to Pro</Link>
              </Button>
            </CardContent>
          </Card>
        )}
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
          <div>
            <h2 className="text-2xl font-display font-bold uppercase text-secondary">Teams & Seasons</h2>
            {summary.seasonScope === "current" && (
              <p className="text-xs text-muted-foreground mt-1">
                Showing current season only.{" "}
                <Link href="/billing" className="text-primary underline">Upgrade to Pro</Link> for full career history.
              </p>
            )}
          </div>
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
          <>
            {selectedTeamIds.length > 0 && (
              <CombinedSeasonsSummary
                selectedTeamIds={selectedTeamIds}
                playerId={playerId}
                allTeams={teams}
                onClear={() => setSelectedTeamIds([])}
                isPro={isPro}
              />
            )}
            <Accordion type="multiple" className="space-y-4">
              {teams.map(team => (
                <TeamGamesAccordionItem
                  key={team.teamId}
                  team={team}
                  playerId={playerId}
                  isPro={isPro}
                  selected={selectedTeamIds.includes(team.teamId)}
                  onToggleSelect={() => toggleTeamSelection(team.teamId)}
                />
              ))}
            </Accordion>
          </>
        )}
      </div>
    </div>
  );
}

function PlayerChip({ playerId, name, active, onClick, onDelete }: { playerId: number, name: string, active: boolean, onClick: () => void, onDelete?: () => void }) {
  const { data: summary } = useGetPlayerSummary(playerId, {
    query: { enabled: !!playerId, queryKey: getGetPlayerSummaryQueryKey(playerId) }
  });

  return (
    <div
      className={`flex items-center rounded border transition-colors whitespace-nowrap font-medium text-sm ${
        active
          ? "bg-primary text-primary-foreground border-primary shadow-[0_0_16px_hsl(var(--primary)/0.4)]"
          : "bg-muted/60 text-muted-foreground border-border/60 hover:bg-muted"
      }`}
    >
      <button
        onClick={onClick}
        className="flex items-center gap-2 px-4 py-2"
      >
        <span>{name}</span>
        {summary && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${active ? "bg-secondary-foreground/20" : "bg-foreground/10"}`}>
            {summary.games}GP · {summary.ppg.toFixed(1)}PPG
          </span>
        )}
      </button>
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className={`pr-2.5 pl-1 py-2 opacity-50 hover:opacity-100 transition-opacity ${active ? "hover:text-primary-foreground" : "hover:text-destructive"}`}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
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

function computeSeasonStats(games: any[], playerId: number) {
  let wins = 0, losses = 0, pts = 0, reb = 0, ast = 0, stl = 0, blk = 0, to = 0;
  let ftM = 0, ftA = 0, twM = 0, twA = 0, thM = 0, thA = 0;
  for (const game of games) {
    const stat = game.stats?.find((s: any) => s.playerId === playerId);
    if (!stat) continue;
    if (game.result === "W") wins++; else losses++;
    pts += stat.points ?? 0;
    reb += stat.rebounds ?? 0; ast += stat.assists ?? 0;
    stl += stat.steals ?? 0; blk += stat.blocks ?? 0; to += stat.turnovers ?? 0;
    ftM += stat.ftMade ?? 0; ftA += stat.ftAttempted ?? 0;
    twM += stat.twoMade ?? 0; twA += stat.twoAttempted ?? 0;
    thM += stat.threeMade ?? 0; thA += stat.threeAttempted ?? 0;
  }
  const gp = wins + losses;
  const sd = (a: number, b: number) => (b > 0 ? a / b : 0);
  const fgM = twM + thM, fgA = twA + thA;
  return {
    gp, wins, losses, pts, reb, ast, stl, blk, to,
    ftM, ftA, fgM, fgA, thM, thA,
    ppg: sd(pts, gp), rpg: sd(reb, gp), apg: sd(ast, gp),
    spg: sd(stl, gp), bpg: sd(blk, gp), topg: sd(to, gp),
    fgPct: sd(fgM, fgA), threePct: sd(thM, thA), ftPct: sd(ftM, ftA),
  };
}

function SeasonSummaryBand({ playerGames, playerId, isPro }: {
  playerGames: any[];
  playerId: number;
  isPro: boolean;
}) {
  if (playerGames.length === 0) return null;
  const s = computeSeasonStats(playerGames, playerId);
  const tiles = [
    { label: "GP", value: String(s.gp), sub: `${s.wins}W-${s.losses}L` },
    { label: "PPG", value: s.ppg.toFixed(1), sub: `${s.pts} pts` },
    { label: "RPG", value: s.rpg.toFixed(1), sub: `${s.reb} reb` },
    { label: "APG", value: s.apg.toFixed(1), sub: `${s.ast} ast` },
    { label: "SPG", value: s.spg.toFixed(1), sub: `${s.stl} stl` },
    { label: "BPG", value: s.bpg.toFixed(1), sub: `${s.blk} blk` },
    { label: "TOPG", value: s.topg.toFixed(1), sub: `${s.to} to` },
    ...(isPro
      ? [
          { label: "FG%", value: pct(s.fgM, s.fgA), sub: `${s.fgM}/${s.fgA}` },
          { label: "3P%", value: pct(s.thM, s.thA), sub: `${s.thM}/${s.thA}` },
          { label: "FT%", value: pct(s.ftM, s.ftA), sub: `${s.ftM}/${s.ftA}` },
        ]
      : []),
  ];
  return (
    <div className="border-b border-border/60 bg-muted/20">
      <div className="text-[0.55rem] font-bold uppercase tracking-[0.25em] text-muted-foreground px-4 pt-2 pb-0">
        Season Totals
      </div>
      <div className="overflow-x-auto scrollbar-hide">
        <div className="flex items-stretch divide-x divide-border/40 min-w-max">
          {tiles.map(({ label, value, sub }) => (
            <div key={label} className="px-4 py-2 text-center flex-shrink-0">
              <div className="text-[0.55rem] font-bold text-muted-foreground uppercase tracking-[0.2em]">{label}</div>
              <div className="text-base font-display font-bold text-foreground leading-none mt-0.5">{value}</div>
              <div className="text-[0.6rem] font-mono text-muted-foreground/70 mt-0.5">{sub}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TeamGamesFetcher({
  teamId, playerId, onLoad,
}: {
  teamId: number;
  playerId: number;
  onLoad: (teamId: number, games: any[]) => void;
}) {
  const { data: games } = useListTeamGames(teamId, {
    query: { queryKey: getListTeamGamesQueryKey(teamId) },
  });
  useEffect(() => {
    if (games !== undefined) {
      const playerGames = games.filter((g: any) => g.stats?.some((s: any) => s.playerId === playerId));
      onLoad(teamId, playerGames);
    }
  }, [games, teamId, playerId, onLoad]);
  return null;
}

function CombinedSeasonsSummary({
  selectedTeamIds, playerId, allTeams, onClear, isPro,
}: {
  selectedTeamIds: number[];
  playerId: number;
  allTeams: { teamId: number; teamName: string }[];
  onClear: () => void;
  isPro: boolean;
}) {
  const [gamesData, setGamesData] = useState<Record<number, any[]>>({});

  const handleLoad = useCallback((teamId: number, games: any[]) => {
    setGamesData(prev => ({ ...prev, [teamId]: games }));
  }, []);

  const combinedGames = selectedTeamIds.flatMap(id => gamesData[id] ?? []);
  const stats = combinedGames.length > 0 ? computeSeasonStats(combinedGames, playerId) : null;
  const loadedCount = selectedTeamIds.filter(id => gamesData[id] !== undefined).length;
  const isLoading = loadedCount < selectedTeamIds.length;

  const names = selectedTeamIds
    .map(id => allTeams.find(t => t.teamId === id)?.teamName)
    .filter(Boolean) as string[];

  return (
    <div className="mb-4 rounded-xl border border-primary/40 bg-primary/5 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-300">
      {selectedTeamIds.map(teamId => (
        <TeamGamesFetcher key={teamId} teamId={teamId} playerId={playerId} onLoad={handleLoad} />
      ))}
      <div className="flex items-center justify-between px-4 py-3 border-b border-primary/20">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="w-4 h-4 text-primary shrink-0" />
          <span className="font-display font-bold uppercase text-sm tracking-wide text-foreground truncate">
            {selectedTeamIds.length === 1 ? names[0] : `${names.join(" + ")} Combined`}
          </span>
          {isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary shrink-0" />}
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="h-7 text-xs shrink-0 ml-2">
          Clear
        </Button>
      </div>

      {!stats ? (
        <div className="p-6 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-primary/20 border-b border-primary/20">
            {[
              { label: "Points / GM", value: stats.ppg.toFixed(1), sub: `${stats.pts} total` },
              { label: "Games", value: String(stats.gp), sub: `${stats.wins}W · ${stats.losses}L` },
              { label: "Reb / GM", value: stats.rpg.toFixed(1), sub: `${stats.reb} total` },
              { label: "Ast / GM", value: stats.apg.toFixed(1), sub: `${stats.ast} total` },
            ].map(({ label, value, sub }, i) => (
              <div key={label} className={`px-4 py-4 text-center ${i >= 2 ? "border-t md:border-t-0 border-primary/20" : ""}`}>
                <div className="text-[0.6rem] font-bold text-muted-foreground uppercase tracking-[0.2em]">{label}</div>
                <div className="text-3xl font-display font-bold text-primary leading-none mt-1">{value}</div>
                <div className="text-[0.65rem] font-mono text-muted-foreground mt-1">{sub}</div>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-3 md:grid-cols-6 divide-x divide-border/40">
            {[
              { label: "SPG", value: stats.spg.toFixed(1), sub: `${stats.stl} stl` },
              { label: "BPG", value: stats.bpg.toFixed(1), sub: `${stats.blk} blk` },
              { label: "TOPG", value: stats.topg.toFixed(1), sub: `${stats.to} to` },
              { label: "FG%", value: isPro ? pct(stats.fgM, stats.fgA) : "—", sub: isPro ? `${stats.fgM}/${stats.fgA}` : "Pro" },
              { label: "3P%", value: isPro ? pct(stats.thM, stats.thA) : "—", sub: isPro ? `${stats.thM}/${stats.thA}` : "Pro" },
              { label: "FT%", value: isPro ? pct(stats.ftM, stats.ftA) : "—", sub: isPro ? `${stats.ftM}/${stats.ftA}` : "Pro" },
            ].map(({ label, value, sub }) => (
              <div key={label} className="px-3 py-3 text-center">
                <div className="text-[0.55rem] font-bold text-muted-foreground uppercase tracking-[0.2em]">{label}</div>
                <div className="text-lg font-display font-bold text-foreground leading-none mt-0.5">{value}</div>
                <div className="text-[0.6rem] font-mono text-muted-foreground/70 mt-0.5">{sub}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TeamFormDialog({ trigger, team, onSaved }: { trigger: React.ReactNode, team?: { id: number, name: string }, onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team?.name || "");
  const [sport, setSport] = useState<"basketball" | "soccer">("basketball");
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
        await createTeam.mutateAsync({ data: { name: name.trim(), sport } });
        toast({ title: "Team added" });
      }
      setOpen(false);
      setName(team ? name : "");
      setSport("basketball");
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
          {!team && (
            <div className="space-y-2">
              <Label>Sport</Label>
              <div className="flex gap-2">
                {(["basketball", "soccer"] as const).map(s => (
                  <Button
                    key={s}
                    type="button"
                    variant={sport === s ? "default" : "outline"}
                    className="flex-1 capitalize"
                    onClick={() => setSport(s)}
                  >{s}</Button>
                ))}
              </div>
            </div>
          )}
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

function TeamGamesAccordionItem({ team, playerId, isPro, selected, onToggleSelect }: { team: any, playerId: number, isPro: boolean, selected: boolean, onToggleSelect: () => void }) {
  const { data: games, isLoading } = useListTeamGames(team.teamId, {
    query: { enabled: !!team.teamId, queryKey: getListTeamGamesQueryKey(team.teamId) }
  });

  const deleteGame = useDeleteGame();
  const deleteTeam = useDeleteTeam();
  const mergeGamesMutation = useMergeGames();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Multi-select state for game merge
  const [selectedGameIds, setSelectedGameIds] = useState<Set<number>>(new Set());
  const [showMergeDialog, setShowMergeDialog] = useState(false);

  // Edit stats dialog
  const [editStatsGame, setEditStatsGame] = useState<Game | null>(null);

  const toggleGameSelection = (gameId: number) => {
    setSelectedGameIds(prev => {
      const next = new Set(prev);
      if (next.has(gameId)) next.delete(gameId);
      else next.add(gameId);
      return next;
    });
  };

  const handleMerge = async () => {
    if (selectedGameIds.size < 2) return;
    // Primary = earliest selected game (by its position in the sorted list)
    const allGames = games ?? [];
    const selectedOrdered = allGames.filter(g => selectedGameIds.has(g.id));
    const [primary, ...secondaries] = selectedOrdered;
    try {
      await mergeGamesMutation.mutateAsync({ data: { primaryGameId: primary.id, secondaryGameIds: secondaries.map(g => g.id) } });
      queryClient.invalidateQueries({ queryKey: getListTeamGamesQueryKey(team.teamId) });
      queryClient.invalidateQueries({ queryKey: getGetPlayerSummaryQueryKey(playerId) });
      queryClient.invalidateQueries({ queryKey: getListPlayerTeamGroupsQueryKey(playerId) });
      setSelectedGameIds(new Set());
      setShowMergeDialog(false);
      toast({ title: "Games merged", description: `${selectedGameIds.size} games combined into one.` });
    } catch {
      toast({ title: "Merge failed", description: "Could not merge games. Make sure all selected games are on the same team.", variant: "destructive" });
    }
  };

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

  const statCardRef = useRef<HTMLDivElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportGame, setExportGame] = useState<{
    gameId: number;
    playerName: string;
    teamName: string;
    opponent: string;
    date: string;
    result: string;
    teamScore: number;
    opponentScore: number;
    stat: {
      points: number; rebounds: number; assists: number; steals: number;
      blocks: number; turnovers: number; ftMade: number; ftAttempted: number;
      twoMade: number; twoAttempted: number; threeMade: number; threeAttempted: number;
    };
  } | null>(null);

  useEffect(() => {
    if (!exportGame || !statCardRef.current) return;
    let cancelled = false;
    const run = async () => {
      setIsExporting(true);
      try {
        const { default: html2canvas } = await import("html2canvas");
        const canvas = await html2canvas(statCardRef.current!, {
          scale: 2, useCORS: true, backgroundColor: null, logging: false,
        });
        const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
        if (!blob || cancelled) return;
        const safeName = (s: string) => s.replace(/[^a-z0-9]/gi, "-").toLowerCase();
        const filename = `${safeName(exportGame.playerName)}-vs-${safeName(exportGame.opponent)}.png`;
        const file = new File([blob], filename, { type: "image/png" });
        if (typeof navigator.canShare === "function" && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: `${exportGame.playerName} – Game Stats` });
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = filename; a.click();
          URL.revokeObjectURL(url);
        }
      } catch {
        toast({ title: "Export failed", description: "Could not generate the stat card.", variant: "destructive" });
      } finally {
        if (!cancelled) { setIsExporting(false); setExportGame(null); }
      }
    };
    run();
    return () => { cancelled = true; };
  }, [exportGame]);

  const playerGames = games?.filter(g => g.stats.some(s => s.playerId === playerId)) || [];

  const { data: seasonHighlight } = useGetTeamHighlight(team.teamId, {
    query: { enabled: !!team.teamId, queryKey: getGetTeamHighlightQueryKey(team.teamId) }
  });
  const generateSeasonHighlight = useGenerateTeamHighlight();

  const seasonHighlightFileName = () => `stec-season-highlights-${team.teamName || "team"}.mp4`;

  const handleGenerateSeasonHighlight = async () => {
    try {
      await generateSeasonHighlight.mutateAsync({ teamId: team.teamId });
      queryClient.invalidateQueries({ queryKey: getGetTeamHighlightQueryKey(team.teamId) });
    } catch (err) {
      toast({ title: "Couldn't start the season highlight reel", variant: "destructive" });
    }
  };

  const handleDownloadSeasonHighlight = () => {
    if (!seasonHighlight?.highlightObjectPath) return;
    const a = document.createElement("a");
    a.href = videoObjectSrc(seasonHighlight.highlightObjectPath);
    a.download = seasonHighlightFileName();
    a.click();
  };

  const handleShareSeasonHighlight = async () => {
    if (!seasonHighlight?.highlightObjectPath) return;
    try {
      const res = await fetch(videoObjectSrc(seasonHighlight.highlightObjectPath));
      const blob = await res.blob();
      const file = new File([blob], seasonHighlightFileName(), { type: "video/mp4" });
      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean; share?: (data: { files: File[]; title: string }) => Promise<void> };
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        await nav.share({ files: [file], title: "Season Highlights" });
      } else {
        handleDownloadSeasonHighlight();
      }
    } catch (err) {
      toast({ title: "Couldn't share the season highlight reel", variant: "destructive" });
    }
  };

  return (
    <AccordionItem value={team.teamId.toString()} className="border rounded-lg bg-card overflow-hidden">
      {/* Hidden stat card rendered off-screen for html2canvas capture */}
      <div style={{ position: "fixed", top: -20000, left: -20000, pointerEvents: "none", opacity: 0 }}>
        {exportGame && (
          <GameStatCard
            ref={statCardRef}
            playerName={exportGame.playerName}
            teamName={exportGame.teamName}
            opponent={exportGame.opponent}
            date={exportGame.date}
            result={exportGame.result}
            teamScore={exportGame.teamScore}
            opponentScore={exportGame.opponentScore}
            stat={exportGame.stat}
          />
        )}
      </div>
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
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
            className={`h-8 w-8 rounded flex items-center justify-center transition-colors ${
              selected ? "bg-primary text-primary-foreground" : "text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted"
            }`}
            title={selected ? "Remove from combined summary" : "Add to combined summary"}
          >
            <Check className="h-4 w-4" />
          </button>
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
          <>
            <SeasonSummaryBand playerGames={playerGames} playerId={playerId} isPro={isPro} />

            {/* Merge selection banner */}
            {selectedGameIds.size >= 2 && (
              <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/10 border-b border-primary/20">
                <GitMerge className="w-4 h-4 text-primary shrink-0" />
                <span className="text-sm font-medium text-primary flex-1">
                  {selectedGameIds.size} games selected — combine them into one
                </span>
                <Button size="sm" onClick={() => setShowMergeDialog(true)}>
                  Merge games
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelectedGameIds(new Set())}>
                  Cancel
                </Button>
              </div>
            )}

            <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-8 pl-4"></TableHead>
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
                  const isSelected = selectedGameIds.has(game.id);

                  return (
                    <TableRow key={game.id} className={`group ${isSelected ? "bg-primary/5" : ""}`}>
                      <TableCell className="pl-4 pr-0">
                        <button
                          type="button"
                          onClick={() => toggleGameSelection(game.id)}
                          className="text-muted-foreground/40 hover:text-primary transition-colors"
                          title={isSelected ? "Deselect" : "Select to merge"}
                        >
                          {isSelected
                            ? <SquareCheck className="h-4 w-4 text-primary" />
                            : <Square className="h-4 w-4" />
                          }
                        </button>
                      </TableCell>
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
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            title="Share stat card"
                            disabled={isExporting}
                            onClick={() => {
                              if (!stat) return;
                              setExportGame({
                                gameId: game.id,
                                playerName: stat.playerName,
                                teamName: game.teamName,
                                opponent: game.opponent,
                                date: game.date,
                                result: game.result,
                                teamScore: game.teamScore,
                                opponentScore: game.opponentScore,
                                stat,
                              });
                            }}
                          >
                            {isExporting && exportGame?.gameId === game.id ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Share2 className="h-4 w-4" />
                            )}
                          </Button>
                          {game.videoObjectPath ? (
                            <span title="Footage saved" className="inline-flex items-center justify-center h-8 w-8 text-green-500">
                              <Video className="h-4 w-4" />
                            </span>
                          ) : (
                            <span title="No footage" className="inline-flex items-center justify-center h-8 w-8 text-muted-foreground/30">
                              <Video className="h-4 w-4" />
                            </span>
                          )}
                          {isPro ? (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-primary" title="Game Highlight Reel" asChild>
                              <Link href={`/record/${game.id}`}><Film className="h-4 w-4" /></Link>
                            </Button>
                          ) : (
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground/40" title="Game Highlight Reel (Pro)" asChild>
                              <Link href="/pricing"><Lock className="h-3.5 w-3.5" /></Link>
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-foreground"
                            title="Edit stats"
                            onClick={() => {
                              const fullGame = games?.find(g => g.id === game.id);
                              if (fullGame) setEditStatsGame(fullGame);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
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
          </>
        )}

        {playerGames.length > 0 && (
          <div className="p-4 border-t">
            <div className="max-w-md rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-primary" />
                <span className="font-display font-bold uppercase tracking-wide text-foreground">Season Highlight Reel</span>
                {!isPro && <span className="ml-auto text-xs font-bold text-primary border border-primary/40 rounded px-1.5 py-0.5 flex items-center gap-1"><Lock className="w-3 h-3" /> Pro</span>}
              </div>

              {!isPro ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Combine the best plays from every recorded game into one shareable reel. Upgrade to Pro to unlock highlight reels — for every game and the full season.
                  </p>
                  <Button type="button" asChild>
                    <Link href="/pricing"><Sparkles className="w-4 h-4 mr-2" /> Upgrade to Pro</Link>
                  </Button>
                </div>
              ) : seasonHighlight && seasonHighlight.eligibleMoments === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Tag some made shots, rebounds, assists, steals or blocks in recorded games to build a season highlight reel.
                </p>
              ) : seasonHighlight?.status === "processing" ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Building your season highlight reel… this can take a few minutes.
                </p>
              ) : seasonHighlight?.status === "ready" && seasonHighlight.highlightObjectPath ? (
                <div className="space-y-3">
                  <video
                    src={videoObjectSrc(seasonHighlight.highlightObjectPath)}
                    controls
                    playsInline
                    preload="none"
                    className="block w-auto max-w-full max-h-[70vh] mx-auto rounded-lg bg-black landscape:max-h-none landscape:w-[62vw]"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" onClick={handleShareSeasonHighlight}>
                      <Share2 className="w-4 h-4 mr-2" /> Share
                    </Button>
                    <Button type="button" variant="outline" onClick={handleDownloadSeasonHighlight}>
                      <Download className="w-4 h-4 mr-2" /> Download
                    </Button>
                    <Button type="button" variant="ghost" onClick={handleGenerateSeasonHighlight} disabled={generateSeasonHighlight.isPending}>
                      {generateSeasonHighlight.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                      Regenerate
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Combine the best plays from every recorded game on this team into one shareable clip{seasonHighlight ? ` — ${seasonHighlight.eligibleMoments} moment${seasonHighlight.eligibleMoments === 1 ? "" : "s"} found` : ""}.
                  </p>
                  {seasonHighlight?.status === "failed" && seasonHighlight.error && (
                    <p className="text-sm text-destructive">{seasonHighlight.error}</p>
                  )}
                  <Button type="button" onClick={handleGenerateSeasonHighlight} disabled={generateSeasonHighlight.isPending}>
                    {generateSeasonHighlight.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                    {seasonHighlight?.status === "failed" ? "Try Again" : "Generate Season Highlight Reel"}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </AccordionContent>

      {/* Edit stats dialog */}
      {editStatsGame && (
        <EditStatsDialog
          game={editStatsGame}
          open={!!editStatsGame}
          onOpenChange={open => { if (!open) setEditStatsGame(null); }}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: getListTeamGamesQueryKey(team.teamId) });
            queryClient.invalidateQueries({ queryKey: getGetPlayerSummaryQueryKey(playerId) });
            queryClient.invalidateQueries({ queryKey: getListPlayerTeamGroupsQueryKey(playerId) });
          }}
        />
      )}

      {/* Merge games confirmation dialog */}
      <Dialog open={showMergeDialog} onOpenChange={setShowMergeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="w-5 h-5 text-primary" /> Merge {selectedGameIds.size} games into one?
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <p className="text-sm text-muted-foreground">
              Stats will be added together across all selected games. The earliest game keeps its date and opponent name. This can't be undone.
            </p>
            {(() => {
              const allGames = playerGames.filter(g => selectedGameIds.has(g.id));
              return (
                <div className="rounded-lg border border-border/60 divide-y divide-border/60 text-sm">
                  {allGames.map((g, i) => (
                    <div key={g.id} className="flex items-center gap-3 px-3 py-2">
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${i === 0 ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                        {i === 0 ? "Primary" : `Part ${i + 1}`}
                      </span>
                      <span className="font-medium flex-1">vs {g.opponent}</span>
                      <span className="font-mono text-xs text-muted-foreground">{new Date(g.date).toLocaleDateString()}</span>
                      <span className={`font-bold text-xs ${g.result === "W" ? "text-green-500" : "text-red-500"}`}>
                        {g.teamScore}–{g.opponentScore}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
            {games?.filter(g => selectedGameIds.has(g.id) && g.videoObjectPath).length! >= 2 && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Video className="w-3.5 h-3.5 shrink-0" />
                Videos will be joined in the background — this may take a few minutes.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMergeDialog(false)}>Cancel</Button>
            <Button onClick={handleMerge} disabled={mergeGamesMutation.isPending}>
              {mergeGamesMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <GitMerge className="w-4 h-4 mr-2" />}
              Merge games
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AccordionItem>
  );
}

// ─── Edit Stats Dialog ────────────────────────────────────────────────────────

type EditableStatLine = {
  playerId: number;
  playerName: string;
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
  // soccer fields — preserved as-is so they aren't zeroed on save
  goals: number;
  shots: number;
  shotsOffTarget: number;
  saves: number;
  yellowCards: number;
  redCards: number;
};

function initEditableStats(stats: PlayerGameStatLine[]): EditableStatLine[] {
  return stats.map(s => ({
    playerId: s.playerId,
    playerName: s.playerName,
    ftMade: s.ftMade,
    ftAttempted: s.ftAttempted,
    twoMade: s.twoMade,
    twoAttempted: s.twoAttempted,
    threeMade: s.threeMade,
    threeAttempted: s.threeAttempted,
    assists: s.assists,
    rebounds: s.rebounds,
    steals: s.steals,
    turnovers: s.turnovers,
    blocks: s.blocks,
    goals: s.goals ?? 0,
    shots: s.shots ?? 0,
    shotsOffTarget: s.shotsOffTarget ?? 0,
    saves: s.saves ?? 0,
    yellowCards: s.yellowCards ?? 0,
    redCards: s.redCards ?? 0,
  }));
}

function EditStatsDialog({
  game,
  open,
  onOpenChange,
  onSaved,
}: {
  game: Game;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const updateGame = useUpdateGame();
  const generateHighlight = useGenerateGameHighlight();
  const [lines, setLines] = useState<EditableStatLine[]>([]);
  const [regenReel, setRegenReel] = useState(false);

  // Game metadata state
  const [editOpponent, setEditOpponent] = useState(game.opponent);
  const [editDate, setEditDate] = useState(game.date ? game.date.slice(0, 10) : "");
  const [editTeamScore, setEditTeamScore] = useState(game.teamScore);
  const [editOpponentScore, setEditOpponentScore] = useState(game.opponentScore);
  const [editResult, setEditResult] = useState<"W" | "L">(game.result as "W" | "L");

  // Re-initialize when dialog opens
  useEffect(() => {
    if (open) {
      setLines(initEditableStats(game.stats));
      setEditOpponent(game.opponent);
      setEditDate(game.date ? game.date.slice(0, 10) : "");
      setEditTeamScore(game.teamScore);
      setEditOpponentScore(game.opponentScore);
      setEditResult(game.result as "W" | "L");
      setRegenReel(false);
    }
  }, [open, game]);

  const setLineStat = (
    playerId: number,
    field: keyof Omit<EditableStatLine, "playerId" | "playerName">,
    delta: number,
  ) => {
    setLines(prev =>
      prev.map(l => {
        if (l.playerId !== playerId) return l;
        const raw = l[field] + delta;
        const next = Math.max(0, raw);
        // enforce made ≤ attempted
        const updated = { ...l, [field]: next };
        if (field === "ftMade") updated.ftAttempted = Math.max(updated.ftAttempted, next);
        if (field === "ftAttempted") updated.ftMade = Math.min(updated.ftMade, next);
        if (field === "twoMade") updated.twoAttempted = Math.max(updated.twoAttempted, next);
        if (field === "twoAttempted") updated.twoMade = Math.min(updated.twoMade, next);
        if (field === "threeMade") updated.threeAttempted = Math.max(updated.threeAttempted, next);
        if (field === "threeAttempted") updated.threeMade = Math.min(updated.threeMade, next);
        return updated;
      }),
    );
  };

  const handleSave = async () => {
    if (!editOpponent.trim()) {
      toast({ title: "Opponent name is required", variant: "destructive" });
      return;
    }
    if (!editDate) {
      toast({ title: "Game date is required", variant: "destructive" });
      return;
    }
    try {
      await updateGame.mutateAsync({
        gameId: game.id,
        data: {
          teamId: game.teamId,
          opponent: editOpponent.trim(),
          date: editDate,
          result: editResult,
          teamScore: editTeamScore,
          opponentScore: editOpponentScore,
          videoObjectPath: game.videoObjectPath ?? null,
          videoOffsetMs: game.videoOffsetMs ?? null,
          stats: lines.map(l => ({
            playerId: l.playerId,
            ftMade: l.ftMade,
            ftAttempted: l.ftAttempted,
            twoMade: l.twoMade,
            twoAttempted: l.twoAttempted,
            threeMade: l.threeMade,
            threeAttempted: l.threeAttempted,
            assists: l.assists,
            rebounds: l.rebounds,
            steals: l.steals,
            turnovers: l.turnovers,
            blocks: l.blocks,
            // preserve soccer fields unchanged so they aren't zeroed
            goals: l.goals,
            shots: l.shots,
            shotsOffTarget: l.shotsOffTarget,
            saves: l.saves,
            yellowCards: l.yellowCards,
            redCards: l.redCards,
          })),
          events: game.events.map(e => ({
            playerId: e.playerId,
            statField: e.statField,
            delta: e.delta,
            videoTimestampMs: e.videoTimestampMs ?? 0,
          })),
        },
      });

      // Fire-and-forget reel regeneration if the coach opted in.
      if (regenReel) {
        generateHighlight.mutate({ gameId: game.id });
      }

      toast({
        title: "Game updated",
        description: regenReel
          ? "Stats saved. Reel regeneration started in the background."
          : "Opponent, score, date, and stats saved.",
      });
      onOpenChange(false);
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message.replace(/^HTTP \d+ [^:]*:\s*/, "") : "Failed to save stats";
      toast({ title: "Error", description: msg, variant: "destructive" });
    }
  };

  const gameDate = new Date(game.date).toLocaleDateString();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display uppercase text-xl">
            Edit Stats — vs {game.opponent}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {gameDate} · {game.result === "W" ? "Win" : "Loss"} {game.teamScore}–{game.opponentScore}
          </p>
        </DialogHeader>

        {game.highlightStatus === "ready" && (
          <div className="flex items-start gap-3 rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              This game already has a highlight reel. Saving stat changes won't automatically regenerate it.
            </p>
          </div>
        )}

        <div className="space-y-6 py-2">
          {/* Game metadata */}
          <div className="rounded-lg border border-border/60 p-4 space-y-3">
            <p className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground">Game Info</p>
            <div className="space-y-2">
              <Label htmlFor="edit-opponent">Opponent</Label>
              <Input
                id="edit-opponent"
                value={editOpponent}
                onChange={e => setEditOpponent(e.target.value)}
                placeholder="Opponent name"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="edit-date">Date</Label>
                <Input
                  id="edit-date"
                  type="date"
                  value={editDate}
                  onChange={e => setEditDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Result</Label>
                <div className="flex gap-2">
                  {(["W", "L"] as const).map(r => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setEditResult(r)}
                      className={`flex-1 py-1.5 rounded text-sm font-bold border transition-colors ${
                        editResult === r
                          ? r === "W"
                            ? "bg-green-600 text-white border-green-600"
                            : "bg-red-600 text-white border-red-600"
                          : "bg-transparent text-muted-foreground border-border hover:bg-muted"
                      }`}
                    >
                      {r === "W" ? "Win" : "Loss"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="edit-team-score">Our Score</Label>
                <Input
                  id="edit-team-score"
                  type="number"
                  min={0}
                  value={editTeamScore}
                  onChange={e => setEditTeamScore(Math.max(0, parseInt(e.target.value) || 0))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-opp-score">Their Score</Label>
                <Input
                  id="edit-opp-score"
                  type="number"
                  min={0}
                  value={editOpponentScore}
                  onChange={e => setEditOpponentScore(Math.max(0, parseInt(e.target.value) || 0))}
                />
              </div>
            </div>
          </div>

          {/* Player stats */}
          {lines.map(line => (
            <div key={line.playerId} className="space-y-3 rounded-lg border border-border/60 p-4">
              <p className="font-display font-bold uppercase tracking-wide text-sm text-foreground">
                {line.playerName}
              </p>

              {/* Shooting stats: made / attempted pairs */}
              <div className="grid grid-cols-3 gap-3">
                <ShootingCounter
                  label="Free Throws"
                  made={line.ftMade}
                  attempted={line.ftAttempted}
                  onMadeChange={d => setLineStat(line.playerId, "ftMade", d)}
                  onAttChange={d => setLineStat(line.playerId, "ftAttempted", d)}
                />
                <ShootingCounter
                  label="2-Pointers"
                  made={line.twoMade}
                  attempted={line.twoAttempted}
                  onMadeChange={d => setLineStat(line.playerId, "twoMade", d)}
                  onAttChange={d => setLineStat(line.playerId, "twoAttempted", d)}
                />
                <ShootingCounter
                  label="3-Pointers"
                  made={line.threeMade}
                  attempted={line.threeAttempted}
                  onMadeChange={d => setLineStat(line.playerId, "threeMade", d)}
                  onAttChange={d => setLineStat(line.playerId, "threeAttempted", d)}
                />
              </div>

              {/* Counting stats */}
              <div className="grid grid-cols-5 gap-2">
                {(
                  [
                    { label: "AST", field: "assists" },
                    { label: "REB", field: "rebounds" },
                    { label: "STL", field: "steals" },
                    { label: "BLK", field: "blocks" },
                    { label: "TO",  field: "turnovers" },
                  ] as { label: string; field: keyof Omit<EditableStatLine, "playerId" | "playerName"> }[]
                ).map(({ label, field }) => (
                  <CountingCounter
                    key={field}
                    label={label}
                    value={line[field] as number}
                    onChange={d => setLineStat(line.playerId, field, d)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter className="flex-col gap-3 sm:flex-col">
          {game.highlightStatus === "ready" && (
            <label className="flex items-center gap-2 cursor-pointer select-none text-sm w-full">
              <input
                type="checkbox"
                className="accent-primary h-4 w-4 rounded"
                checked={regenReel}
                onChange={e => setRegenReel(e.target.checked)}
              />
              <span className="text-foreground">Regenerate reel after saving</span>
            </label>
          )}
          <div className="flex gap-2 justify-end w-full">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={updateGame.isPending || !editDate}>
              {updateGame.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShootingCounter({
  label,
  made,
  attempted,
  onMadeChange,
  onAttChange,
}: {
  label: string;
  made: number;
  attempted: number;
  onMadeChange: (d: number) => void;
  onAttChange: (d: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground leading-none">{label}</span>
      <div className="flex flex-col gap-1 w-full">
        <div className="flex items-center justify-between gap-1 rounded border border-border/60 px-1 py-0.5">
          <button
            type="button"
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground"
            onClick={() => onMadeChange(-1)}
            disabled={made <= 0}
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="text-xs font-mono font-bold w-4 text-center">{made}</span>
          <button
            type="button"
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground"
            onClick={() => onMadeChange(1)}
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
        <div className="flex items-center justify-between gap-1 rounded border border-border/40 bg-muted/30 px-1 py-0.5">
          <button
            type="button"
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground"
            onClick={() => onAttChange(-1)}
            disabled={attempted <= 0}
          >
            <Minus className="w-3 h-3" />
          </button>
          <span className="text-[0.65rem] font-mono text-muted-foreground w-4 text-center">{attempted}</span>
          <button
            type="button"
            className="w-5 h-5 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground"
            onClick={() => onAttChange(1)}
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
        <div className="text-[0.55rem] text-muted-foreground/60 text-center leading-none">made / att</div>
      </div>
    </div>
  );
}

function CountingCounter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (d: number) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground leading-none">{label}</span>
      <div className="flex flex-col items-center gap-0.5">
        <button
          type="button"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground"
          onClick={() => onChange(1)}
        >
          <Plus className="w-3 h-3" />
        </button>
        <span className="text-sm font-mono font-bold w-6 text-center">{value}</span>
        <button
          type="button"
          className="w-6 h-6 flex items-center justify-center rounded hover:bg-muted transition-colors text-muted-foreground"
          onClick={() => onChange(-1)}
          disabled={value <= 0}
        >
          <Minus className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}
