import { useState } from "react";
import { useImportData } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, FileType, CheckCircle2, ArrowRight } from "lucide-react";
import { Link } from "wouter";

export default function ImportData() {
  const [csvText, setCsvText] = useState("");
  const [parsedRows, setParsedRows] = useState<any[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<any>(null);
  
  const importData = useImportData();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleParse = () => {
    setErrors([]);
    setImportResult(null);
    if (!csvText.trim()) return;

    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      setErrors(["CSV must have a header row and at least one data row."]);
      return;
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const expectedHeaders = ['teamname', 'opponent', 'date', 'result', 'teamscore', 'opponentscore', 'playername', 'ftmade', 'ftattempted', 'twomade', 'twoattempted', 'threemade', 'threeattempted', 'assists', 'rebounds', 'steals', 'turnovers', 'blocks'];
    
    // Check if headers roughly match
    const missingHeaders = expectedHeaders.filter(eh => !headers.includes(eh));
    if (missingHeaders.length > 0) {
      setErrors([`Missing required columns: ${missingHeaders.join(', ')}`]);
      return;
    }

    const rows: any[] = [];
    const parseErrors: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      const values = line.split(',').map(v => v.trim());
      const row: any = {};
      
      let hasError = false;
      headers.forEach((h, idx) => {
        const val = values[idx];
        if (['teamscore', 'opponentscore', 'ftmade', 'ftattempted', 'twomade', 'twoattempted', 'threemade', 'threeattempted', 'assists', 'rebounds', 'steals', 'turnovers', 'blocks'].includes(h)) {
          const num = parseInt(val, 10);
          if (isNaN(num)) {
            parseErrors.push(`Row ${i}: Invalid number for ${h}`);
            hasError = true;
          }
          row[h] = num;
        } else {
          row[h] = val;
        }
      });

      if (!hasError) {
        rows.push({
          teamName: row.teamname,
          opponent: row.opponent,
          date: row.date,
          result: row.result.toUpperCase() === 'W' ? 'W' : 'L',
          teamScore: row.teamscore,
          opponentScore: row.opponentscore,
          playerName: row.playername,
          ftMade: row.ftmade,
          ftAttempted: row.ftattempted,
          twoMade: row.twomade,
          twoAttempted: row.twoattempted,
          threeMade: row.threemade,
          threeAttempted: row.threeattempted,
          assists: row.assists,
          rebounds: row.rebounds,
          steals: row.steals,
          turnovers: row.turnovers,
          blocks: row.blocks
        });
      }
    }

    setErrors(parseErrors);
    setParsedRows(rows);
  };

  const handleImport = async () => {
    if (parsedRows.length === 0) return;
    
    try {
      const res = await importData.mutateAsync({ data: { rows: parsedRows } });
      setImportResult(res);
      queryClient.invalidateQueries(); // Invalidate everything
      toast({ title: "Import successful" });
      setCsvText("");
      setParsedRows([]);
    } catch(err) {
      toast({ title: "Import failed", variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col space-y-6 max-w-4xl mx-auto w-full">
      <div>
        <h1 className="text-4xl font-display font-bold uppercase tracking-tight text-secondary">Import Data</h1>
        <p className="text-muted-foreground">Upload or paste CSV data to bulk create players, teams, and games.</p>
      </div>

      {importResult && (
        <Card className="border-green-500 bg-green-500/5">
          <CardContent className="p-6 flex flex-col items-center text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-green-500 text-white flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <h2 className="text-2xl font-display font-bold uppercase text-green-700">Import Complete</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full">
              <div className="bg-card p-4 rounded border shadow-sm">
                <div className="text-3xl font-display font-bold text-primary">{importResult.playersCreated}</div>
                <div className="text-xs uppercase font-bold text-muted-foreground">Players</div>
              </div>
              <div className="bg-card p-4 rounded border shadow-sm">
                <div className="text-3xl font-display font-bold text-primary">{importResult.teamsCreated}</div>
                <div className="text-xs uppercase font-bold text-muted-foreground">Teams</div>
              </div>
              <div className="bg-card p-4 rounded border shadow-sm">
                <div className="text-3xl font-display font-bold text-primary">{importResult.gamesCreated}</div>
                <div className="text-xs uppercase font-bold text-muted-foreground">Games</div>
              </div>
              <div className="bg-card p-4 rounded border shadow-sm">
                <div className="text-3xl font-display font-bold text-primary">{importResult.statLinesCreated}</div>
                <div className="text-xs uppercase font-bold text-muted-foreground">Stat Lines</div>
              </div>
            </div>
            <Button asChild className="mt-4" size="lg">
              <Link href="/">Go to Dashboard <ArrowRight className="w-4 h-4 ml-2" /></Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {!importResult && (
        <Card>
          <CardHeader>
            <CardTitle>Paste CSV</CardTitle>
            <CardDescription>
              Include the following headers exactly:<br/>
              <code className="text-xs bg-muted p-1 rounded">teamName,opponent,date,result,teamScore,opponentScore,playerName,ftMade,ftAttempted,twoMade,twoAttempted,threeMade,threeAttempted,assists,rebounds,steals,turnovers,blocks</code>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Textarea 
              placeholder="Paste CSV text here..." 
              className="font-mono text-xs min-h-[200px]"
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
            <Button onClick={handleParse} className="w-full">Parse CSV</Button>
            
            {errors.length > 0 && (
              <div className="bg-destructive/10 text-destructive p-4 rounded border border-destructive/20 text-sm space-y-1">
                <p className="font-bold">Errors found:</p>
                <ul className="list-disc pl-5">
                  {errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!importResult && parsedRows.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Preview ({parsedRows.length} rows)</CardTitle>
              <CardDescription>Review the parsed data before committing.</CardDescription>
            </div>
            <Button onClick={handleImport} disabled={importData.isPending} size="lg" className="font-display uppercase tracking-wide text-lg">
              {importData.isPending && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
              <Upload className="w-5 h-5 mr-2" />
              Import Data
            </Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Player</TableHead>
                    <TableHead>Team</TableHead>
                    <TableHead>Opponent</TableHead>
                    <TableHead>Res</TableHead>
                    <TableHead>PTS</TableHead>
                    <TableHead>REB</TableHead>
                    <TableHead>AST</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsedRows.slice(0, 50).map((row, i) => {
                    const pts = (row.twoMade * 2) + (row.threeMade * 3) + row.ftMade;
                    return (
                      <TableRow key={i}>
                        <TableCell className="font-mono text-xs">{row.date}</TableCell>
                        <TableCell className="font-medium">{row.playerName}</TableCell>
                        <TableCell>{row.teamName}</TableCell>
                        <TableCell>{row.opponent}</TableCell>
                        <TableCell>{row.result}</TableCell>
                        <TableCell className="font-bold">{pts}</TableCell>
                        <TableCell>{row.rebounds}</TableCell>
                        <TableCell>{row.assists}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {parsedRows.length > 50 && (
                <div className="p-4 text-center text-muted-foreground text-sm border-t">
                  Showing first 50 rows. {parsedRows.length - 50} more rows hidden.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
