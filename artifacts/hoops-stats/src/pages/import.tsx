import { useRef, useState } from "react";
import * as XLSX from "xlsx";
import { useImportData } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, FileType, CheckCircle2, ArrowRight, ArrowLeft, FileSpreadsheet } from "lucide-react";
import { Link } from "wouter";

type TargetField = {
  key: string;
  label: string;
  numeric?: boolean;
};

const TARGET_FIELDS: TargetField[] = [
  { key: "teamName", label: "Team / Season Name" },
  { key: "opponent", label: "Opponent" },
  { key: "date", label: "Date" },
  { key: "result", label: "Result (W/L)" },
  { key: "teamScore", label: "Team Score", numeric: true },
  { key: "opponentScore", label: "Opponent Score", numeric: true },
  { key: "playerName", label: "Player Name" },
  { key: "ftMade", label: "FT Made", numeric: true },
  { key: "ftAttempted", label: "FT Attempted", numeric: true },
  { key: "twoMade", label: "2PT Made", numeric: true },
  { key: "twoAttempted", label: "2PT Attempted", numeric: true },
  { key: "threeMade", label: "3PT Made", numeric: true },
  { key: "threeAttempted", label: "3PT Attempted", numeric: true },
  { key: "assists", label: "Assists", numeric: true },
  { key: "rebounds", label: "Rebounds", numeric: true },
  { key: "steals", label: "Steals", numeric: true },
  { key: "turnovers", label: "Turnovers", numeric: true },
  { key: "blocks", label: "Blocks", numeric: true },
];

const NORMALIZE_ALIASES: Record<string, string[]> = {
  teamName: ["teamname", "team", "season", "team/season"],
  opponent: ["opponent", "opp"],
  date: ["date", "gamedate"],
  result: ["result", "wl", "w/l"],
  teamScore: ["teamscore", "score", "pointsfor"],
  opponentScore: ["opponentscore", "oppscore", "pointsagainst"],
  playerName: ["playername", "player", "name"],
  ftMade: ["ftmade", "ftm", "freethrowsmade"],
  ftAttempted: ["ftattempted", "fta", "freethrowsattempted"],
  twoMade: ["twomade", "2pm", "2pmade", "fgmtwo"],
  twoAttempted: ["twoattempted", "2pa", "2pattempted"],
  threeMade: ["threemade", "3pm", "3pmade"],
  threeAttempted: ["threeattempted", "3pa", "3pattempted"],
  assists: ["assists", "ast"],
  rebounds: ["rebounds", "reb"],
  steals: ["steals", "stl"],
  turnovers: ["turnovers", "to", "tov"],
  blocks: ["blocks", "blk"],
};

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const FIXED_VALUE_FIELDS = new Set(["teamName", "playerName"]);
const PARSE_FROM_RESULT = "__parse_from_result__";

function countHeaderMatches(row: string[]) {
  const normalized = row.map(c => normalize(c.trim()));
  let matches = 0;
  for (const aliases of Object.values(NORMALIZE_ALIASES)) {
    if (normalized.some(n => n && aliases.includes(n))) matches++;
  }
  return matches;
}

function detectHeaderRowIndex(rows: string[][]): number {
  let bestIdx = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const score = countHeaderMatches(rows[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function guessPlayerNameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const cut = base.replace(/[_\s]*stats.*$/i, "");
  return cut.replace(/[_\s]+/g, " ").trim();
}

function guessTeamNameAboveHeader(rows: string[][], headerIdx: number): string {
  for (let i = headerIdx - 1; i >= 0; i--) {
    const nonEmpty = rows[i].filter(c => c.trim() !== "");
    if (nonEmpty.length === 1 && nonEmpty[0].length < 40) {
      return nonEmpty[0].trim();
    }
  }
  return "";
}

function parseResultString(raw: string): { result: "W" | "L" | null; teamScore: number | null; opponentScore: number | null } {
  const match = raw.match(/^\s*(W|L)\D*(\d+)\D+(\d+)/i);
  if (!match) return { result: null, teamScore: null, opponentScore: null };
  return {
    result: match[1].toUpperCase() as "W" | "L",
    teamScore: parseInt(match[2], 10),
    opponentScore: parseInt(match[3], 10),
  };
}

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char === "\r") {
        // skip, handled by \n
      } else {
        field += char;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.some(c => c.trim() !== ""));
}

export default function ImportData() {
  const [step, setStep] = useState<"upload" | "mapping" | "preview" | "done">("upload");
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mappingMode, setMappingMode] = useState<Record<string, "column" | "fixed">>({});
  const [fixedValues, setFixedValues] = useState<Record<string, string>>({});
  const [fileName, setFileName] = useState("");
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [mappedRows, setMappedRows] = useState<any[]>([]);
  const [importResult, setImportResult] = useState<any>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importData = useImportData();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const resetAll = () => {
    setStep("upload");
    setHeaders([]);
    setDataRows([]);
    setMapping({});
    setMappingMode({});
    setFixedValues({});
    setFileName("");
    setParseErrors([]);
    setImportResult(null);
  };

  const handleFile = async (file: File) => {
    setFileName(file.name);
    let allRows: string[][] = [];

    try {
      if (file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv") {
        const text = await file.text();
        allRows = parseCsvText(text);
      } else {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" });
        allRows = json.map(r => r.map(c => (c === undefined || c === null ? "" : String(c)))).filter(r => r.some(c => c.trim() !== ""));
      }
    } catch (err) {
      toast({ title: "Could not read file", description: "Make sure it's a valid CSV or Excel file.", variant: "destructive" });
      return;
    }

    if (allRows.length < 2) {
      toast({ title: "No data found", description: "The file needs a header row plus at least one data row.", variant: "destructive" });
      return;
    }

    const headerIdx = detectHeaderRowIndex(allRows);
    const hdrs = allRows[headerIdx].map(h => h.trim());
    const body = allRows.slice(headerIdx + 1);

    const autoMapping: Record<string, string> = {};
    for (const field of TARGET_FIELDS) {
      const aliases = NORMALIZE_ALIASES[field.key] || [field.key];
      const match = hdrs.find(h => aliases.includes(normalize(h)));
      if (match) autoMapping[field.key] = match;
    }

    const autoMode: Record<string, "column" | "fixed"> = {};
    const autoFixed: Record<string, string> = {};

    if (!autoMapping.playerName) {
      autoMode.playerName = "fixed";
      autoFixed.playerName = guessPlayerNameFromFileName(file.name);
    }
    if (!autoMapping.teamName) {
      autoMode.teamName = "fixed";
      autoFixed.teamName = guessTeamNameAboveHeader(allRows, headerIdx);
    }
    if (!autoMapping.teamScore && !autoMapping.opponentScore && autoMapping.result) {
      autoMapping.teamScore = PARSE_FROM_RESULT;
      autoMapping.opponentScore = PARSE_FROM_RESULT;
    }

    setHeaders(hdrs);
    setDataRows(body);
    setMapping(autoMapping);
    setMappingMode(autoMode);
    setFixedValues(autoFixed);
    setStep("mapping");
  };

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const isFixed = (key: string) => FIXED_VALUE_FIELDS.has(key) && mappingMode[key] === "fixed";

  const buildPreview = () => {
    const missing = TARGET_FIELDS.filter(f => {
      if (isFixed(f.key)) return !fixedValues[f.key]?.trim();
      if (mapping[f.key] === PARSE_FROM_RESULT) return false;
      return !mapping[f.key];
    });
    if (missing.length > 0) {
      toast({ title: "Finish mapping columns", description: `Map: ${missing.map(m => m.label).join(", ")}`, variant: "destructive" });
      return;
    }

    const errors: string[] = [];
    const rows: any[] = [];

    dataRows.forEach((raw, idx) => {
      const rowObj: any = {};
      let hasError = false;
      const resultColIdx = headers.indexOf(mapping.result);
      const resultRawVal = (raw[resultColIdx] ?? "").toString().trim();
      const parsedResult = parseResultString(resultRawVal);

      for (const field of TARGET_FIELDS) {
        if (isFixed(field.key)) {
          rowObj[field.key] = fixedValues[field.key].trim();
          continue;
        }

        if (mapping[field.key] === PARSE_FROM_RESULT) {
          if (field.key === "teamScore" && parsedResult.teamScore !== null) {
            rowObj[field.key] = parsedResult.teamScore;
          } else if (field.key === "opponentScore" && parsedResult.opponentScore !== null) {
            rowObj[field.key] = parsedResult.opponentScore;
          } else {
            errors.push(`Row ${idx + 2}: could not parse score from result ("${resultRawVal}")`);
            hasError = true;
            rowObj[field.key] = 0;
          }
          continue;
        }

        const colIdx = headers.indexOf(mapping[field.key]);
        const rawVal = (raw[colIdx] ?? "").toString().trim();

        if (field.numeric) {
          const num = parseInt(rawVal, 10);
          if (isNaN(num)) {
            errors.push(`Row ${idx + 2}: invalid number for ${field.label} ("${rawVal}")`);
            hasError = true;
          }
          rowObj[field.key] = isNaN(num) ? 0 : num;
        } else if (field.key === "result") {
          rowObj[field.key] = parsedResult.result ?? (rawVal.toUpperCase().startsWith("W") ? "W" : "L");
        } else {
          rowObj[field.key] = rawVal;
        }
      }

      if (!hasError) rows.push(rowObj);
    });

    setParseErrors(errors);
    setMappedRows(rows);
    setStep("preview");
  };

  const handleImport = async () => {
    if (mappedRows.length === 0) return;
    try {
      const res = await importData.mutateAsync({ data: { rows: mappedRows } });
      setImportResult(res);
      queryClient.invalidateQueries();
      toast({ title: "Import successful" });
      setStep("done");
    } catch (err) {
      toast({ title: "Import failed", variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col space-y-6 max-w-5xl mx-auto w-full">
      <div>
        <h1 className="text-4xl font-display font-bold uppercase tracking-tight text-secondary">Import Data</h1>
        <p className="text-muted-foreground">Upload your Monday.com CSV or Excel export, map the columns, then preview before committing.</p>
      </div>

      {step === "done" && importResult && (
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
            <div className="flex gap-3 mt-4">
              <Button variant="outline" onClick={resetAll}>Import Another File</Button>
              <Button asChild size="lg">
                <Link href="/dashboard">Go to Dashboard <ArrowRight className="w-4 h-4 ml-2" /></Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle>Upload File</CardTitle>
            <CardDescription>Drop a .csv or .xlsx export from Monday.com, one row per player per game.</CardDescription>
          </CardHeader>
          <CardContent>
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-muted rounded-lg py-16 flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-primary/50 hover:bg-muted/30 transition-colors"
            >
              <FileSpreadsheet className="w-10 h-10 text-muted-foreground" />
              <p className="font-medium">Click to browse or drag a file here</p>
              <p className="text-xs text-muted-foreground">Supports .csv, .xlsx, .xls</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                onChange={onFileInputChange}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {step === "mapping" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileType className="w-5 h-5" /> Map Columns — {fileName}</CardTitle>
            <CardDescription>Match each field the app needs to a column detected in your file. We auto-matched what we could recognize.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid md:grid-cols-2 gap-3">
              {TARGET_FIELDS.map(field => {
                const canBeFixed = FIXED_VALUE_FIELDS.has(field.key);
                const fixedMode = isFixed(field.key);
                const canParseFromResult = (field.key === "teamScore" || field.key === "opponentScore") && !!mapping.result;

                return (
                  <div key={field.key} className="flex flex-col gap-2 border rounded-md p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">{field.label}</span>
                      {canBeFixed && (
                        <button
                          type="button"
                          className="text-xs text-primary underline"
                          onClick={() => setMappingMode(m => ({ ...m, [field.key]: fixedMode ? "column" : "fixed" }))}
                        >
                          {fixedMode ? "Use a column instead" : "Same value for all rows"}
                        </button>
                      )}
                    </div>

                    {fixedMode ? (
                      <input
                        className="border rounded-md px-3 py-2 text-sm bg-background"
                        placeholder={`Fixed ${field.label.toLowerCase()}`}
                        value={fixedValues[field.key] || ""}
                        onChange={(e) => setFixedValues(v => ({ ...v, [field.key]: e.target.value }))}
                      />
                    ) : (
                      <Select value={mapping[field.key] || ""} onValueChange={(v) => setMapping(m => ({ ...m, [field.key]: v }))}>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select column..." />
                        </SelectTrigger>
                        <SelectContent>
                          {canParseFromResult && (
                            <SelectItem value={PARSE_FROM_RESULT}>Parse from Result column</SelectItem>
                          )}
                          {headers.map((h, idx) => (
                            h ? <SelectItem key={`${h}-${idx}`} value={h}>{h}</SelectItem> : null
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between pt-4">
              <Button variant="outline" onClick={resetAll}><ArrowLeft className="w-4 h-4 mr-2" /> Choose different file</Button>
              <Button onClick={buildPreview}>Preview Import <ArrowRight className="w-4 h-4 ml-2" /></Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "preview" && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Preview ({mappedRows.length} rows)</CardTitle>
              <CardDescription>Review the mapped data before committing.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep("mapping")}><ArrowLeft className="w-4 h-4 mr-2" /> Back</Button>
              <Button onClick={handleImport} disabled={importData.isPending || mappedRows.length === 0} size="lg" className="font-display uppercase tracking-wide text-lg">
                {importData.isPending && <Loader2 className="w-5 h-5 mr-2 animate-spin" />}
                <Upload className="w-5 h-5 mr-2" />
                Import Data
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {parseErrors.length > 0 && (
              <div className="bg-destructive/10 text-destructive p-4 rounded border border-destructive/20 text-sm space-y-1">
                <p className="font-bold">{parseErrors.length} row(s) skipped due to errors:</p>
                <ul className="list-disc pl-5 max-h-32 overflow-y-auto">
                  {parseErrors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}
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
                  {mappedRows.slice(0, 50).map((row, i) => {
                    const pts = row.twoMade * 2 + row.threeMade * 3 + row.ftMade;
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
              {mappedRows.length > 50 && (
                <div className="p-4 text-center text-muted-foreground text-sm border-t">
                  Showing first 50 rows. {mappedRows.length - 50} more rows hidden.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
