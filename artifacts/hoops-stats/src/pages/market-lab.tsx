import { useEffect, type ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Film,
  Menu,
  Play,
  Smartphone,
  Trophy,
  Users,
} from "lucide-react";

const orange = "#f36b32";

function SectionLabel({ index, children, light = false }: { index: string; children: ReactNode; light?: boolean }) {
  return (
    <div className={`flex items-center gap-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] ${light ? "text-[#9b9b91]" : "text-[#a54824]"}`}>
      <span className={`flex h-7 w-7 items-center justify-center rounded-full border ${light ? "border-[#666960]" : "border-[#d6cfc1]"}`}>{index}</span>
      <span>{children}</span>
    </div>
  );
}

function CourtDiagram() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden opacity-[0.13]">
      <div className="absolute left-1/2 top-1/2 h-[490px] w-[490px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#f8e9d7]" />
      <div className="absolute left-1/2 top-1/2 h-[170px] w-[170px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#f8e9d7]" />
      <div className="absolute left-1/2 top-0 h-full border-l border-[#f8e9d7]" />
      <div className="absolute left-0 top-[20%] h-[60%] w-[14%] border border-l-0 border-[#f8e9d7]" />
      <div className="absolute right-0 top-[20%] h-[60%] w-[14%] border border-r-0 border-[#f8e9d7]" />
      <div className="absolute -left-[14%] top-1/2 h-[80%] w-[38%] -translate-y-1/2 rounded-full border border-[#f8e9d7]" />
      <div className="absolute -right-[14%] top-1/2 h-[80%] w-[38%] -translate-y-1/2 rounded-full border border-[#f8e9d7]" />
    </div>
  );
}

export default function MarketLab() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "StecStats for Coaches | Development Concept";
    const robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const previousRobots = robots?.getAttribute("content") ?? null;
    const devRobots = robots ?? document.createElement("meta");
    if (!robots) {
      devRobots.name = "robots";
      document.head.appendChild(devRobots);
    }
    devRobots.setAttribute("content", "noindex, nofollow");
    let description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const existed = Boolean(description);
    const previousDescription = description?.getAttribute("content") ?? null;
    if (!description) {
      description = document.createElement("meta");
      description.name = "description";
      document.head.appendChild(description);
    }
    description.setAttribute("content", "A development-only marketing direction for StecStats: scoring, player history, and game media in one place for youth basketball coaches.");
    return () => {
      document.title = previousTitle;
      if (!robots) devRobots.remove();
      else if (previousRobots === null) devRobots.removeAttribute("content");
      else devRobots.setAttribute("content", previousRobots);
      if (!existed) description?.remove();
      else if (previousDescription === null) description?.removeAttribute("content");
      else description?.setAttribute("content", previousDescription);
    };
  }, []);

  return (
    <div className="min-h-[100dvh] overflow-x-hidden bg-[#f1eee5] text-[#262a27] selection:bg-[#f36b32] selection:text-[#1f2521]">
      <div className="border-b border-[#c9c4b7] bg-[#e7e2d5] px-5 py-2.5 text-center font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#6d5143]" data-testid="status-development-concept">
        Development concept · Not a published campaign
      </div>

      <header className="relative z-20 border-b border-[#c9c4b7] bg-[#f1eee5]">
        <div className="mx-auto flex h-[76px] max-w-[1440px] items-center justify-between gap-5 px-5 sm:px-8 lg:px-12">
          <Link href="/" className="flex shrink-0 items-center gap-2.5" data-testid="link-home-logo" aria-label="StecStats home">
            <img src="/logo.svg" alt="" className="h-9 w-9 rounded-[9px]" />
            <span className="font-display text-[29px] font-bold uppercase leading-none tracking-[0.015em]">StecStats<span className="text-[#ec632e]">.</span></span>
          </Link>
          <nav aria-label="Page sections" className="hidden items-center gap-8 lg:flex">
            <a href="#the-gap" data-testid="link-nav-the-gap" className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] transition-colors hover:text-[#db5525]">The gap</a>
            <a href="#the-system" data-testid="link-nav-the-system" className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] transition-colors hover:text-[#db5525]">The system</a>
            <a href="#how-it-works" data-testid="link-nav-how-it-works" className="font-mono text-[10px] font-bold uppercase tracking-[0.15em] transition-colors hover:text-[#db5525]">Game to season</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/pricing" data-testid="link-header-pricing" className="hidden font-mono text-[10px] font-bold uppercase tracking-[0.13em] underline decoration-[#e6a28a] underline-offset-4 hover:text-[#db5525] sm:inline-flex">View pricing</Link>
            <Link href="/sign-up" data-testid="link-header-signup" className="inline-flex items-center gap-2 bg-[#262a27] px-4 py-3 font-mono text-[10px] font-bold uppercase tracking-[0.12em] text-[#f5f1e8] transition-colors hover:bg-[#db5525] sm:px-5">
              Get started <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <main>
        <section className="relative isolate overflow-hidden bg-[#252a27] text-[#f4f0e6]">
          <CourtDiagram />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,#252a27_7%,transparent_68%)]" />
          <div className="relative mx-auto grid max-w-[1440px] items-center gap-12 px-5 pb-14 pt-16 sm:px-8 md:pb-20 md:pt-24 lg:min-h-[710px] lg:grid-cols-[1.02fr_0.98fr] lg:gap-8 lg:px-12">
            <div className="max-w-[790px]">
              <div className="mb-7 flex items-center gap-3 font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-[#f69a70]">
                <span className="h-[1px] w-8 bg-[#f36b32]" /> For the coaches who keep the game moving
              </div>
              <h1 className="font-display text-[clamp(5rem,11.2vw,10.4rem)] font-bold uppercase leading-[0.72] tracking-[-0.025em]">
                THE GAME<br /><span className="text-[#f36b32]">DOESN&apos;T</span><br />STOP.
              </h1>
              <p className="mt-9 max-w-[520px] border-l-2 border-[#f36b32] pl-5 text-base leading-relaxed text-[#d9d9cd] sm:text-lg">
                Neither should the story of your team. Score the action, follow every player&apos;s progress, and keep game media connected to the season in one place.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Link href="/sign-up" data-testid="link-hero-signup" className="group inline-flex min-h-12 items-center justify-center gap-5 bg-[#f36b32] px-6 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[#252a27] transition-colors hover:bg-[#ff8752]">
                  Start with your team <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </Link>
                <a href="#the-system" data-testid="link-hero-explore" className="inline-flex min-h-12 items-center justify-center gap-3 border border-[#696c64] px-6 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[#f4f0e6] transition-colors hover:border-[#f36b32] hover:text-[#f36b32]">
                  Explore the idea <ArrowDown className="h-4 w-4" />
                </a>
              </div>
            </div>

            <div className="relative mx-auto w-full max-w-[590px] lg:ml-auto" aria-label="Illustrative StecStats game and player views">
              <div className="absolute -left-5 -top-5 hidden h-24 w-24 border-l border-t border-[#f36b32]/70 sm:block" />
              <div className="absolute -bottom-5 -right-5 hidden h-24 w-24 border-b border-r border-[#f36b32]/70 sm:block" />
              <div className="border border-[#676b63] bg-[#161c1a] p-3 shadow-[16px_20px_0px_#151a18] sm:p-4">
                <div className="flex items-center justify-between border-b border-[#3c4440] pb-3 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-[#a7aca1]">
                  <span className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-[#f36b32]" /> StecStats / Game view</span>
                  <span>Concept preview</span>
                </div>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-[#3c4440] py-6 text-center sm:py-8">
                  <div><span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#b4b9ae]">Your team</span><div className="mt-2 font-display text-4xl uppercase leading-none sm:text-5xl">HOME</div></div>
                  <div className="font-display text-5xl leading-none text-[#f36b32] sm:text-7xl">– : –</div>
                  <div><span className="font-mono text-[10px] uppercase tracking-[0.15em] text-[#b4b9ae]">Opponent</span><div className="mt-2 font-display text-4xl uppercase leading-none sm:text-5xl">AWAY</div></div>
                </div>
                <div className="grid grid-cols-[1.15fr_0.85fr] gap-3 pt-3">
                  <div className="border border-[#3c4440] bg-[#222925] p-3 sm:p-4">
                    <div className="mb-5 flex items-center justify-between gap-2 font-mono text-[9px] font-bold uppercase tracking-[0.13em] text-[#b1b6aa]"><span>Player stat line</span><BarChart3 className="h-3.5 w-3.5 text-[#f36b32]" /></div>
                    <div className="space-y-2">
                      {["Points", "Rebounds", "Assists"].map((item, index) => (
                        <div key={item} className="flex items-center justify-between border-b border-[#3a423e] pb-2 font-mono text-[10px] text-[#e8e6dc]">
                          <span className="flex items-center gap-2"><span className="text-[#f36b32]">0{index + 1}</span> {item}</span><span>—</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col justify-between bg-[#ed6a34] p-3 text-[#252a27] sm:p-4">
                    <Film className="h-5 w-5" strokeWidth={1.8} />
                    <div><span className="font-mono text-[9px] font-bold uppercase tracking-[0.13em]">Game media</span><p className="mt-1 font-display text-2xl font-bold uppercase leading-[0.9] sm:text-3xl">Moments worth keeping.</p></div>
                  </div>
                </div>
              </div>
              <p className="mt-5 text-right font-mono text-[9px] uppercase tracking-[0.15em] text-[#9da197]">Illustrative interface · Not live game data</p>
            </div>
          </div>
          <div className="relative border-t border-[#4a504a]">
            <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-10 gap-y-3 px-5 py-5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#b9bcb2] sm:px-8 lg:px-12">
              <span className="text-[#f36b32]">One connected season</span><span>01 / Score the game</span><span>02 / See the player</span><span>03 / Revisit the moment</span>
            </div>
          </div>
        </section>

        <section id="the-gap" className="scroll-mt-10 border-b border-[#d0cabd] bg-[#f1eee5]">
          <div className="mx-auto grid max-w-[1440px] gap-10 px-5 py-20 sm:px-8 md:py-28 lg:grid-cols-[0.8fr_1.2fr] lg:gap-24 lg:px-12">
            <div><SectionLabel index="01">The courtside reality</SectionLabel><p className="mt-7 max-w-[330px] font-mono text-xs leading-7 text-[#7c7d72]">The final buzzer shouldn&apos;t be the end of the information you worked to capture.</p></div>
            <div>
              <h2 className="max-w-[890px] font-display text-[clamp(3.6rem,7vw,7.3rem)] font-bold uppercase leading-[0.85] tracking-[-0.018em]">A SEASON IS MORE THAN <span className="text-[#dc5d2d]">A STACK OF GAME DAYS.</span></h2>
              <div className="mt-9 grid gap-5 border-t border-[#c7c0b1] pt-7 md:grid-cols-2 md:gap-12">
                <p className="text-base leading-7 text-[#454a43]">You&apos;re tracking who scored, who grew, and what happened when it mattered. Those details deserve to live together, not scattered across notes, spreadsheets, and camera rolls.</p>
                <p className="text-base leading-7 text-[#454a43]">StecStats brings the scorebook, player history, and game media into the same conversation—so you can spend less time piecing things together after the game.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="the-system" className="scroll-mt-10 bg-[#e5e0d3]">
          <div className="mx-auto max-w-[1440px] px-5 py-20 sm:px-8 md:py-28 lg:px-12">
            <div className="flex flex-col justify-between gap-6 border-b border-[#bcb6a8] pb-10 md:flex-row md:items-end">
              <div><SectionLabel index="02">The system</SectionLabel><h2 className="mt-6 font-display text-[clamp(3.9rem,7vw,7.6rem)] font-bold uppercase leading-[0.82]">EVERYTHING<br />HAS A PLACE<span className="text-[#e46633]">.</span></h2></div>
              <p className="max-w-[330px] text-sm leading-7 text-[#5c625a]">A practical home for the parts of coaching that happen during the game—and the questions that come after.</p>
            </div>
            <div className="grid gap-4 pt-5 lg:grid-cols-[1.14fr_0.86fr]">
              <article className="group relative flex min-h-[470px] flex-col justify-between overflow-hidden bg-[#292f2b] p-7 text-[#f3efe5] sm:p-10">
                <div className="absolute right-[-75px] top-[-80px] h-[390px] w-[390px] rounded-full border border-[#6e746b]/40" aria-hidden="true"><div className="absolute inset-12 rounded-full border border-[#6e746b]/40" /><div className="absolute inset-24 rounded-full border border-[#6e746b]/40" /></div>
                <div className="relative flex items-start justify-between"><div className="flex h-12 w-12 items-center justify-center border border-[#696f65]"><ClipboardList className="h-6 w-6 text-[#f36b32]" /></div><span className="font-mono text-[10px] tracking-[0.18em] text-[#a4aa9e]">01 / THE GAME</span></div>
                <div className="relative max-w-[530px]"><p className="mb-4 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#f38b5b]">When the ball is in play</p><h3 className="font-display text-6xl font-bold uppercase leading-[0.85] sm:text-7xl">KEEP SCORE.<br />KEEP CONTEXT.</h3><p className="mt-6 max-w-[435px] text-sm leading-7 text-[#c8cec2]">Capture scoring and player stats as the game unfolds. Build a box score that gives the team a clearer picture of what happened on the court.</p></div>
              </article>
              <div className="grid gap-4">
                <article className="flex min-h-[230px] flex-col justify-between border border-[#c2bbac] bg-[#f2eee4] p-7 sm:p-8">
                  <div className="flex items-start justify-between"><Users className="h-7 w-7 text-[#d65b2d]" strokeWidth={1.6} /><span className="font-mono text-[10px] tracking-[0.18em] text-[#84877c]">02 / THE PLAYER</span></div>
                  <div><h3 className="font-display text-4xl font-bold uppercase leading-none sm:text-5xl">SEE THE WHOLE ARC.</h3><p className="mt-3 max-w-[440px] text-sm leading-6 text-[#5c625a]">Move beyond one box score. Follow player history across games, teams, and seasons.</p></div>
                </article>
                <article className="flex min-h-[230px] flex-col justify-between bg-[#e96a35] p-7 text-[#252a27] sm:p-8">
                  <div className="flex items-start justify-between"><Film className="h-7 w-7" strokeWidth={1.6} /><span className="font-mono text-[10px] tracking-[0.18em]">03 / THE MOMENT</span></div>
                  <div><h3 className="font-display text-4xl font-bold uppercase leading-none sm:text-5xl">BRING THE GAME BACK.</h3><p className="mt-3 max-w-[440px] text-sm leading-6">Keep game media alongside the numbers, where it can help tell a fuller story of the season.</p></div>
                </article>
              </div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-10 overflow-hidden bg-[#252a27] text-[#f1eee5]">
          <div className="mx-auto max-w-[1440px] px-5 py-20 sm:px-8 md:py-28 lg:px-12">
            <SectionLabel index="03" light>From tip-off to next practice</SectionLabel>
            <div className="mt-7 grid gap-8 lg:grid-cols-[1fr_0.8fr] lg:items-end"><h2 className="font-display text-[clamp(4.4rem,8vw,9rem)] font-bold uppercase leading-[0.78]">ONE GAME.<br /><span className="text-[#f36b32]">MORE TO WORK WITH.</span></h2><p className="max-w-[340px] text-base leading-7 text-[#adb4a8] lg:justify-self-end">Not another task for your postgame checklist. A connected record you can come back to when it&apos;s time to review, plan, or remember.</p></div>
            <div className="mt-16 grid border-t border-[#596057] md:grid-cols-2 xl:grid-cols-4">
              {[
                { number: "01", icon: CalendarDays, title: "SET THE GAME", body: "Start with the matchup and the roster you already know." },
                { number: "02", icon: Trophy, title: "MARK THE ACTION", body: "Track the points and player contributions that shape the box score." },
                { number: "03", icon: BarChart3, title: "READ THE STORY", body: "Look back at game stats and see how a player's season is taking shape." },
                { number: "04", icon: Play, title: "REVISIT IT", body: "Find game media in the same place as the rest of the record." },
              ].map(({ number, icon: Icon, title, body }) => (
                <div key={number} className="flex min-h-[275px] flex-col border-b border-[#596057] px-0 py-7 md:px-6 xl:border-r xl:last:border-r-0 xl:px-7">
                  <div className="flex items-center justify-between font-mono text-[10px] text-[#f36b32]"><span>STEP / {number}</span><Icon className="h-5 w-5" strokeWidth={1.6} /></div>
                  <div className="mt-auto pt-12"><h3 className="font-display text-4xl font-bold uppercase leading-none">{title}</h3><p className="mt-3 max-w-[270px] text-sm leading-6 text-[#abb2a6]">{body}</p></div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#f1eee5]">
          <div className="mx-auto grid max-w-[1440px] gap-12 px-5 py-20 sm:px-8 md:py-28 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-20 lg:px-12">
            <div><SectionLabel index="04">Built around the real sideline</SectionLabel><h2 className="mt-7 font-display text-[clamp(4rem,7vw,7.2rem)] font-bold uppercase leading-[0.84]">THE WEB<br />HAS A JOB.<br /><span className="text-[#df622f]">SO DOES THE IPAD.</span></h2><p className="mt-7 max-w-[500px] text-base leading-7 text-[#535a52]">This web and PWA direction is about the space around the game: reviewing stats, finding player history, and accessing game media. It isn&apos;t a replacement for the iPad courtside camera experience.</p></div>
            <div className="relative border border-[#c9c1b1] bg-[#e5e0d3] p-5 sm:p-8">
              <div className="absolute -top-3 right-5 bg-[#f1eee5] px-3 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#a4522f]">A clear division of labor</div>
              <div className="flex items-start gap-5 border-b border-[#c5bdad] py-7 sm:gap-7">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center bg-[#f36b32]"><Smartphone className="h-6 w-6" /></div>
                <div><span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#9b4c2a]">Courtside / iPad</span><h3 className="mt-2 font-display text-3xl font-bold uppercase leading-none sm:text-4xl">STAY IN THE GAME.</h3><p className="mt-3 text-sm leading-6 text-[#555c52]">The focused, in-the-moment experience for the coach on the sideline.</p></div>
              </div>
              <div className="flex items-start gap-5 py-7 sm:gap-7">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center bg-[#292f2b] text-[#f3eee3]"><Menu className="h-6 w-6" /></div>
                <div><span className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-[#9b4c2a]">Between games / web</span><h3 className="mt-2 font-display text-3xl font-bold uppercase leading-none sm:text-4xl">SEE WHAT&apos;S BUILDING.</h3><p className="mt-3 text-sm leading-6 text-[#555c52]">A place to return to the season, the players, and the media attached to each game.</p></div>
              </div>
            </div>
          </div>
        </section>

        <section className="relative overflow-hidden bg-[#e96a35] text-[#262a27]">
          <div aria-hidden="true" className="absolute -right-24 -top-36 h-[600px] w-[600px] rounded-full border border-[#262a27]/20 sm:h-[800px] sm:w-[800px]" />
          <div aria-hidden="true" className="absolute -right-2 -top-16 h-[400px] w-[400px] rounded-full border border-[#262a27]/20 sm:h-[600px] sm:w-[600px]" />
          <div className="relative mx-auto grid max-w-[1440px] gap-9 px-5 py-20 sm:px-8 md:py-28 lg:grid-cols-[1.2fr_0.8fr] lg:items-end lg:px-12">
            <div><p className="font-mono text-[10px] font-bold uppercase tracking-[0.19em]">Your next season starts here</p><h2 className="mt-6 font-display text-[clamp(4.5rem,9vw,10rem)] font-bold uppercase leading-[0.75]">COACH THE<br />WHOLE STORY.</h2></div>
            <div className="lg:pb-1"><p className="max-w-[390px] text-base leading-7">The games are already happening. Give the work you put into them somewhere to live.</p><div className="mt-7 flex flex-wrap gap-3"><Link href="/sign-up" data-testid="link-footer-signup" className="group inline-flex min-h-12 items-center gap-5 bg-[#262a27] px-6 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-[#f4f0e6] transition-colors hover:bg-[#414941]">Get started <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" /></Link><Link href="/pricing" data-testid="link-footer-pricing" className="inline-flex min-h-12 items-center gap-2 border border-[#262a27] px-6 py-3 font-mono text-[11px] font-bold uppercase tracking-[0.12em] transition-colors hover:bg-[#262a27] hover:text-[#f4f0e6]">Explore pricing <ChevronRight className="h-4 w-4" /></Link></div></div>
          </div>
        </section>
      </main>

      <footer className="bg-[#252a27] text-[#f1eee5]">
        <div className="mx-auto flex max-w-[1440px] flex-col gap-8 px-5 py-10 sm:px-8 md:flex-row md:items-end md:justify-between lg:px-12">
          <div><Link href="/" data-testid="link-footer-home" className="inline-flex items-center gap-2.5"><img src="/logo.svg" alt="" className="h-8 w-8 rounded-[7px]" /><span className="font-display text-3xl font-bold uppercase leading-none">StecStats<span style={{ color: orange }}>.</span></span></Link><p className="mt-4 max-w-[340px] text-xs leading-5 text-[#aab1a6]">A development-only marketing concept exploring a coach-focused web direction. Not a published campaign.</p></div>
          <nav aria-label="Footer navigation" className="flex flex-wrap gap-x-6 gap-y-3 font-mono text-[10px] font-bold uppercase tracking-[0.13em] text-[#bcc1b7]"><Link href="/pricing" data-testid="link-footer-nav-pricing" className="hover:text-[#f36b32]">Pricing</Link><Link href="/sign-up" data-testid="link-footer-nav-signup" className="hover:text-[#f36b32]">Get started</Link><Link href="/privacy" data-testid="link-footer-privacy" className="hover:text-[#f36b32]">Privacy</Link><Link href="/terms" data-testid="link-footer-terms" className="hover:text-[#f36b32]">Terms</Link></nav>
        </div>
      </footer>
    </div>
  );
}