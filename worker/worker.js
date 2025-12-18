/**
 * Cloudflare Worker: /api/standings
 * - Pulls ESPN scoreboard data (current season) and computes wins per team.
 * - Computes pool standings from a config JSON (pool-config.json).
 *
 * Deploy options:
 *  A) Worker with KV binding POOL_KV + env var CONFIG_URL pointing at your Pages asset (pool-config.json)
 *  B) Pages Functions: move this into /functions/api/standings.js and read config from static asset fetch.
 *
 * Notes:
 * - ESPN endpoints are unofficial. We intentionally keep parsing shallow and defensive.
 */

const ESPN_SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

const DEFAULT_TTL_MIN = 30; // < 60 minutes per your requirement

function ctString(d){
  // America/Chicago display without bringing in heavy libs
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  }).format(d);
}

// Very small name->abbr mapping (fallback). We try to use ESPN team.abbreviation when available.
const NAME_TO_ABBR = {
  "49ers":"SF","Bears":"CHI","Bengals":"CIN","Bills":"BUF","Broncos":"DEN","Browns":"CLE","Buccaneers":"TB",
  "Cardinals":"ARI","Chargers":"LAC","Chiefs":"KC","Colts":"IND","Commanders":"WSH","Cowboys":"DAL","Dolphins":"MIA",
  "Eagles":"PHI","Falcons":"ATL","Giants":"NYG","Jaguars":"JAX","Jets":"NYJ","Lions":"DET","Packers":"GB",
  "Panthers":"CAR","Patriots":"NE","Raiders":"LV","Rams":"LAR","Ravens":"BAL","Saints":"NO","Seahawks":"SEA",
  "Steelers":"PIT","Texans":"HOU","Titans":"TEN","Vikings":"MIN"
};

async function fetchJson(url){
  const res = await fetch(url, { headers: { "User-Agent": "nfl-wins-pool/1.0" }});
  if(!res.ok) throw new Error(`Fetch failed ${res.status} for ${url}`);
  return await res.json();
}

function buildTeamToOwner(config){
  const map = {};
  for(const [owner, teams] of Object.entries(config.owners || {})){
    for(const t of teams){ map[t] = owner; }
  }
  for(const t of (config.unowned || [])){
    if(!(t in map)) map[t] = "Unowned";
  }
  return map;
}

async function getRegularSeasonWeekEntries(){
  const root = await fetchJson(`${ESPN_SCOREBOARD}`);
  const calendar = root?.leagues?.[0]?.calendar?.[0]?.entries || root?.leagues?.[0]?.calendar?.entries || [];
  const regularEntries = calendar
    .filter(e => e?.label && String(e.label).match(/^\d+$/) && e?.startDate && e?.endDate)
    .slice(0, 18);
  const currentWeek = root?.week?.number || null;
  return { regularEntries, currentWeek };
}

function normalizeTeamName(team){
  // config uses mascot names (e.g., "Ravens"). ESPN provides displayName "Baltimore Ravens" and shortDisplayName "Ravens".
  return team?.shortDisplayName || team?.name || team?.abbreviation || "";
}

async function fetchWeekGrid(weekNumber, config){
  const { regularEntries, currentWeek } = await getRegularSeasonWeekEntries();
  const week = Number(weekNumber || currentWeek || 1);
  const entry = regularEntries.find(e => Number(e.label) === week);
  if(!entry){
    return { week, currentWeek, games: [] };
  }
  const start = entry.startDate.slice(0,10).replaceAll("-","");
  const end = entry.endDate.slice(0,10).replaceAll("-","");
  const weekData = await fetchJson(`${ESPN_SCOREBOARD}?dates=${start}-${end}`);

  const teamToOwner = buildTeamToOwner(config);

  const games = [];
  for(const ev of (weekData?.events || [])){
    const comp = ev?.competitions?.[0];
    if(!comp) continue;
    const comps = comp?.competitors || [];
    const away = comps.find(c => c?.homeAway === "away");
    const home = comps.find(c => c?.homeAway === "home");
    if(!away || !home) continue;

    const awayName = normalizeTeamName(away.team);
    const homeName = normalizeTeamName(home.team);
    const awayOwner = teamToOwner[awayName] || "-";
    const homeOwner = teamToOwner[homeName] || "-";

    const winner = comps.find(c => c?.winner === true);
    const winnerName = winner ? normalizeTeamName(winner.team) : null;
    const winningOwner = winnerName ? (teamToOwner[winnerName] || "-") : "-";

    // Match spreadsheet behavior: only show games where at least one team is owned (i.e., not both unowned)
    const bothUnowned = (awayOwner === "Unowned" && homeOwner === "Unowned");
    if(bothUnowned) continue;

    games.push({
      kickoff_utc: comp?.date || ev?.date || null,
      away: awayName,
      home: homeName,
      winner: winnerName,
      awayOwner,
      homeOwner,
      winningOwner
    });
  }

  // sort by kickoff time then names
  games.sort((a,b)=>{
    const ta = a.kickoff_utc ? Date.parse(a.kickoff_utc) : 0;
    const tb = b.kickoff_utc ? Date.parse(b.kickoff_utc) : 0;
    return ta - tb || a.away.localeCompare(b.away) || a.home.localeCompare(b.home);
  });

  return { week, currentWeek, games, week_label: entry.label, startDate: entry.startDate, endDate: entry.endDate };
}

/**
 * Compute wins for all teams by walking game results.
 * We fetch scoreboard for each regular-season week by date ranges returned in the scoreboard "calendar".
 * This avoids relying on a potentially-different standings endpoint.
 */
async function computeTeamWinsForSeason(seasonYear){
  const { regularEntries } = await getRegularSeasonWeekEntries();

  // Initialize wins
  const winsByAbbr = Object.fromEntries(Object.values(NAME_TO_ABBR).map(a => [a, 0]));

  // For each week date range, fetch scoreboard?dates=YYYYMMDD-YYYYMMDD
  for(const e of regularEntries){
    const start = e.startDate.slice(0,10).replaceAll("-","");
    const end = e.endDate.slice(0,10).replaceAll("-","");
    const weekData = await fetchJson(`${ESPN_SCOREBOARD}?dates=${start}-${end}`);

    const events = weekData?.events || [];
    for(const ev of events){
      const competitions = ev?.competitions || [];
      for(const comp of competitions){
        const competitors = comp?.competitors || [];
        const winner = competitors.find(c => c?.winner === true);
        if(!winner) continue; // not final yet
        const abbr = winner?.team?.abbreviation;
        if(abbr) winsByAbbr[abbr] = (winsByAbbr[abbr] || 0) + 1;
      }
    }
  }

  return winsByAbbr;
}

function buildResponse(config, winsByAbbr){
  const standings = [];
  for(const [owner, teams] of Object.entries(config.owners)){
    const teamRows = teams.map(t => {
      const abbr = NAME_TO_ABBR[t] || t;
      return { team: t, abbr, wins: winsByAbbr[abbr] ?? 0 };
    });
    const total_wins = teamRows.reduce((a,b)=>a+b.wins,0);
    standings.push({ owner, total_wins, teams: teamRows });
  }
  standings.sort((a,b)=> b.total_wins - a.total_wins || a.owner.localeCompare(b.owner));

  const unowned = (config.unowned || []).map(t => {
    const abbr = NAME_TO_ABBR[t] || t;
    return { team: t, abbr, wins: winsByAbbr[abbr] ?? 0 };
  });

  return { standings, unowned };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if(!url.pathname.startsWith("/api/")){
      return new Response("Not found", { status: 404 });
    }

    const ttlMin = Number(env.CACHE_TTL_MINUTES || DEFAULT_TTL_MIN);

    // Load config once for both endpoints
    const configUrl = env.CONFIG_URL;
    if(!configUrl){
      return new Response(JSON.stringify({error:"Missing CONFIG_URL env var"}), { status: 500, headers: {"content-type":"application/json"}});
    }
    const config = await fetchJson(configUrl);

    if(url.pathname === "/api/week"){
      const weekParam = url.searchParams.get("week");
      const cacheKey = `week_cache_v1_${weekParam || "auto"}`;

      if(env.POOL_KV){
        const cached = await env.POOL_KV.get(cacheKey, "json");
        if(cached && cached.expires_at_ms && Date.now() < cached.expires_at_ms){
          return new Response(JSON.stringify(cached.payload), {
            headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" }
          });
        }
      }

      const grid = await fetchWeekGrid(weekParam, config);
      const payload = {
        season: config.season,
        generated_at_ct: ctString(new Date()),
        cache_ttl_minutes: ttlMin,
        timezone: config.timezone || "America/Chicago",
        ...grid
      };

      if(env.POOL_KV){
        await env.POOL_KV.put(cacheKey, JSON.stringify({
          expires_at_ms: Date.now() + ttlMin*60*1000,
          payload
        }));
      }
      return new Response(JSON.stringify(payload), {
        headers: {
          "content-type":"application/json; charset=utf-8",
          "cache-control":"no-store",
          "access-control-allow-origin":"*"
        }
      });
    }

    if(url.pathname !== "/api/standings"){
      return new Response("Not found", { status: 404 });
    }

    const cacheKey = "standings_cache_v1";

    // KV cache (optional but recommended)
    if(env.POOL_KV){
      const cached = await env.POOL_KV.get(cacheKey, "json");
      if(cached && cached.expires_at_ms && Date.now() < cached.expires_at_ms){
        return new Response(JSON.stringify(cached.payload), {
          headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" }
        });
      }
    }

    // Compute wins
    const winsByAbbr = await computeTeamWinsForSeason(config.season || 2025);
    const payloadCore = buildResponse(config, winsByAbbr);

    const payload = {
      season: config.season,
      generated_at_ct: ctString(new Date()),
      cache_ttl_minutes: ttlMin,
      ...payloadCore
    };

    if(env.POOL_KV){
      await env.POOL_KV.put(cacheKey, JSON.stringify({
        expires_at_ms: Date.now() + ttlMin*60*1000,
        payload
      }));
    }

    return new Response(JSON.stringify(payload), {
      headers: {
        "content-type":"application/json; charset=utf-8",
        "cache-control":"no-store",
        "access-control-allow-origin":"*"
      }
    });
  }
};
