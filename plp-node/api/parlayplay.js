/**
 * Vercel Serverless Function: ParlayPlay esports lines proxy.
 * Uses Puppeteer + @sparticuz/chromium to bypass Cloudflare Turnstile
 * and intercept the crossgame/search API response.
 */

const PLP_LEAGUE_MAP = {
  valorant: "VAL",
  val: "VAL",
  lol: "LOL",
  "league of legends": "LOL",
  cs2: "CS2",
  "counter-strike": "CS2",
  "dota 2": "DOTA2",
  dota2: "DOTA2",
  cod: "COD",
  "call of duty": "COD",
};

// In-memory cache (persists across warm Lambda invocations)
let _cache = { data: null, time: 0 };
const CACHE_TTL = 300; // 5 minutes

function normalizePlayer(playerEntry) {
  const results = [];
  try {
    const match = playerEntry.match || {};
    const sport = match.sport || {};
    const league = match.league || {};

    if (sport.sportName !== "eSports") return results;

    const leagueShort = (league.leagueNameShort || "").toLowerCase();
    const game = PLP_LEAGUE_MAP[leagueShort] || "ESPORTS";

    const playerInfo = playerEntry.player || {};
    const playerName = playerInfo.fullName || "";
    const teamAbbr = (playerInfo.team || {}).teamAbbreviation || "";

    const home = (match.homeTeam || {}).teamname || "";
    const away = (match.awayTeam || {}).teamname || "";
    const matchTitle = home && away ? `${home} vs ${away}` : "";
    const matchDate = match.matchDate || "";

    // FG period: determine map prefix from match type
    const matchType = match.matchType || "";
    let prefix = "";
    if (matchType === "best_of_5") prefix = "Maps 1-5 ";
    else if (matchType === "best_of_3") prefix = "Maps 1-3 ";
    else if (matchType === "best_of_2") prefix = "Maps 1-2 ";

    for (const stat of playerEntry.stats || []) {
      const statName = stat.challengeName || "";
      const lineVal = stat.statValue;
      const multiplier = stat.defaultMultiplier;

      if (!statName || lineVal == null) continue;

      const fullStat = `${prefix}${statName}`;

      results.push({
        platform: "ParlayPlay",
        game,
        player: playerName,
        team: teamAbbr,
        match: matchTitle,
        scheduled: matchDate,
        stat: fullStat,
        line: parseFloat(lineVal),
        over_multiplier: multiplier,
        under_multiplier: null,
      });
    }
  } catch (e) {
    // skip malformed entries
  }
  return results;
}

async function scrapeParlayPlay() {
  let chromium, puppeteer;
  try {
    chromium = require("@sparticuz/chromium");
    puppeteer = require("puppeteer-core");
  } catch (e) {
    return { lines: [], available: false, error: "Dependencies not available" };
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Collect API responses
    const apiResponses = {};
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("crossgame/search") && response.status() === 200) {
        try {
          const body = await response.json();
          apiResponses[url] = body;
        } catch (e) {
          // ignore parse errors
        }
      }
    });

    // Navigate to ParlayPlay - this triggers the API calls
    await page.goto("https://parlayplay.io/crossgame/esports", {
      waitUntil: "networkidle2",
      timeout: 40000,
    });

    // Wait a bit for any late API responses
    await new Promise((r) => setTimeout(r, 2000));

    // Parse all captured API responses
    const allLines = [];
    for (const [url, data] of Object.entries(apiResponses)) {
      const entries = data.playerEntries || data.data || [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        allLines.push(...normalizePlayer(entry));
      }
    }

    return {
      lines: allLines,
      available: true,
      count: allLines.length,
      fetched_at: new Date().toISOString(),
    };
  } catch (err) {
    return {
      lines: [],
      available: false,
      error: err.message || String(err),
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // ignore
      }
    }
  }
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const now = Date.now();

  // Serve cached if fresh
  if (_cache.data && now - _cache.time < CACHE_TTL * 1000) {
    return res.status(200).json(_cache.data);
  }

  const result = await scrapeParlayPlay();

  if (result.available) {
    _cache.data = result;
    _cache.time = now;
  }

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=300, stale-while-revalidate=3600"
  );
  return res.status(200).json(result);
};
