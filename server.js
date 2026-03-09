const express = require("express");
const fs = require("fs/promises");
const fetch = require("node-fetch");
const path = require("path");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const PAGE_SIZE = 100;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 12 * 60 * 60 * 1000);
const CACHE_FILE = path.join(__dirname, "data", "cache.json");
const OPENIPF_CACHE_FILE = path.join(__dirname, "data", "openipf-cache.json");
const OPENIPF_OVERRIDES_FILE = path.join(__dirname, "data", "openipf-overrides.json");
const OPENIPF_BASE_URL = "https://www.openipf.org/u/";
const OPENIPF_CACHE_TTL_MS = Number(process.env.OPENIPF_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const OPENIPF_CONCURRENCY = Number(process.env.OPENIPF_CONCURRENCY || 3);
const OPENIPF_CACHE_VERSION = 5;
const DATABASE_URL = process.env.DATABASE_URL || "";
const DATABASE_SSL_MODE = String(process.env.DATABASE_SSL_MODE || "").trim().toLowerCase();
const SPORT80_URL =
  "https://britishpowerlifting.sport80.com/api/public/events/datatable/104/entries/19?data=1&sort=&d=asc&s=&st=";

const weightClasses = [
  { label: "-59kg", id: 110469 },
  { label: "-66kg", id: 110470 },
  { label: "-74kg", id: 110471 },
  { label: "-83kg", id: 110472 },
  { label: "-93kg", id: 110473 },
  { label: "-105kg", id: 110474 },
  { label: "-120kg", id: 110475 },
  { label: "120kg+", id: 110476 },
  { label: "-47kg", id: 110477 },
  { label: "-52kg", id: 110478 },
  { label: "-57kg", id: 110479 },
  { label: "-63kg", id: 110480 },
  { label: "-69kg", id: 110481 },
  { label: "-76kg", id: 110482 },
  { label: "-84kg", id: 110483 },
  { label: "84kg+", id: 110484 }
];

const app = express();

let cache = {
  updatedAt: null,
  classes: {}
};

let refreshPromise = null;
let openIpfCache = {};
let openIpfOverrides = {};
let overridePool = null;
const openIpfRequests = new Map();
let scheduledRefreshTimer = null;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createEmptyClassMap() {
  return Object.fromEntries(weightClasses.map((item) => [item.label, []]));
}

function shouldUseDatabaseOverrides() {
  return Boolean(DATABASE_URL);
}

function getDatabaseSslConfig() {
  if (!DATABASE_SSL_MODE) {
    return undefined;
  }

  if (DATABASE_SSL_MODE === "require") {
    return {
      rejectUnauthorized: false
    };
  }

  if (DATABASE_SSL_MODE === "verify-full") {
    return {
      rejectUnauthorized: true
    };
  }

  throw new Error(`Unsupported DATABASE_SSL_MODE: ${DATABASE_SSL_MODE}`);
}

async function initializeOpenIpfOverrideStore() {
  if (!shouldUseDatabaseOverrides()) {
    return;
  }

  overridePool = new Pool({
    connectionString: DATABASE_URL,
    ssl: getDatabaseSslConfig()
  });

  await overridePool.query(`
    CREATE TABLE IF NOT EXISTS openipf_overrides (
      override_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      club TEXT NOT NULL,
      disambiguation_number TEXT,
      manual_slug TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function normalizeOpenIpfSlug(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function buildOpenIpfUrl(slug) {
  return slug ? `${OPENIPF_BASE_URL}${slug}` : null;
}

function normalizeOpenIpfSlugInput(value) {
  const normalized = normalizeOpenIpfSlug(value);
  return normalized || null;
}

function extractOpenIpfSlugFromInput(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  const directSlug = raw.match(/^[a-z0-9]+$/i);
  if (directSlug) {
    return normalizeOpenIpfSlugInput(raw);
  }

  try {
    const parsedUrl = new URL(raw);
    const match = parsedUrl.pathname.match(/^\/u\/([^/]+)\/?$/i);
    return match ? normalizeOpenIpfSlugInput(match[1]) : null;
  } catch (_error) {
    return null;
  }
}

function normalizeDisambiguationNumber(value) {
  const normalized = String(value || "").trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function buildOpenIpfLookupSlug(baseSlug, disambiguationNumber) {
  if (!baseSlug) {
    return "";
  }

  const suffix = normalizeDisambiguationNumber(disambiguationNumber);
  return suffix ? `${baseSlug}${suffix}` : baseSlug;
}

function getOpenIpfOverrideKey(name, club) {
  return `${normalizeOpenIpfSlug(name)}::${String(club || "").trim().toLowerCase()}`;
}

function getOpenIpfOverrideEntry(name, club) {
  const rawEntry = openIpfOverrides[getOpenIpfOverrideKey(name, club)];

  if (!rawEntry) {
    return {
      disambiguationNumber: null,
      manualSlug: null
    };
  }

  if (typeof rawEntry === "string") {
    return {
      disambiguationNumber: normalizeDisambiguationNumber(rawEntry),
      manualSlug: null
    };
  }

  return {
    disambiguationNumber: normalizeDisambiguationNumber(rawEntry.disambiguationNumber),
    manualSlug: extractOpenIpfSlugFromInput(rawEntry.manualSlug || rawEntry.manualUrl)
  };
}

function getSelectedDisambiguationNumber(name, club) {
  return getOpenIpfOverrideEntry(name, club).disambiguationNumber;
}

function getManualOpenIpfSlug(name, club) {
  return getOpenIpfOverrideEntry(name, club).manualSlug;
}

function normalizeEntry(entry) {
  const name = String(entry?.name || "").trim();
  const openIpfSlug = normalizeOpenIpfSlug(name);

  return {
    name,
    club: String(entry?.club || "").trim(),
    openIpfBaseSlug: openIpfSlug,
    openIpfSlug,
    openIpfUrl: buildOpenIpfUrl(openIpfSlug)
  };
}

function isExcludedEntry(entry) {
  const name = String(entry?.name || "").trim().toLowerCase();
  const club = String(entry?.club || "").trim().toLowerCase();

  return name === "under 18" || club === "under 18";
}

function uniqueEntries(entries) {
  const seen = new Set();

  return entries.filter((entry) => {
    const key = `${entry.name}::${entry.club}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function parseTotalValue(value) {
  const match = String(value || "").match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function compareEntriesByBestTotal(left, right) {
  const leftBestTotal = parseTotalValue(left.bestTotal);
  const rightBestTotal = parseTotalValue(right.bestTotal);

  if (leftBestTotal !== null && rightBestTotal !== null && leftBestTotal !== rightBestTotal) {
    return rightBestTotal - leftBestTotal;
  }

  if (leftBestTotal !== null && rightBestTotal === null) {
    return -1;
  }

  if (leftBestTotal === null && rightBestTotal !== null) {
    return 1;
  }

  return left.name.localeCompare(right.name);
}

function getMeta() {
  const totalEntries = Object.values(cache.classes).reduce((sum, entries) => {
    return sum + entries.filter((entry) => !isExcludedEntry(entry)).length;
  }, 0);

  return {
    updatedAt: cache.updatedAt,
    totalEntries,
    classes: weightClasses.map((item) => ({
      label: item.label,
      count: (cache.classes[item.label] || []).filter((entry) => !isExcludedEntry(entry)).length
    }))
  };
}

function hasUsableCache() {
  return Boolean(cache.updatedAt && Object.values(cache.classes).some((entries) => entries.length > 0));
}

function isCacheFresh() {
  if (!cache.updatedAt) {
    return false;
  }

  return Date.now() - new Date(cache.updatedAt).getTime() < CACHE_TTL_MS;
}

function getNextRefreshDelayMs() {
  if (!cache.updatedAt) {
    return 0;
  }

  const ageMs = Date.now() - new Date(cache.updatedAt).getTime();
  return Math.max(CACHE_TTL_MS - ageMs, 0);
}

function scheduleCacheRefresh() {
  if (scheduledRefreshTimer) {
    clearTimeout(scheduledRefreshTimer);
  }

  const delayMs = getNextRefreshDelayMs();
  scheduledRefreshTimer = setTimeout(async () => {
    try {
      await refreshCache(true);
      console.log(`Scheduled refresh completed at ${cache.updatedAt}`);
    } catch (error) {
      console.error("Scheduled refresh failed", error);
      scheduleCacheRefresh();
    }
  }, delayMs);

  if (typeof scheduledRefreshTimer.unref === "function") {
    scheduledRefreshTimer.unref();
  }
}

async function saveCache() {
  await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
}

async function saveOpenIpfCache() {
  await fs.mkdir(path.dirname(OPENIPF_CACHE_FILE), { recursive: true });
  await fs.writeFile(OPENIPF_CACHE_FILE, JSON.stringify(openIpfCache, null, 2));
}

async function saveOpenIpfOverridesToFile() {
  await fs.mkdir(path.dirname(OPENIPF_OVERRIDES_FILE), { recursive: true });
  await fs.writeFile(OPENIPF_OVERRIDES_FILE, JSON.stringify(openIpfOverrides, null, 2));
}

async function saveOpenIpfOverride(name, club) {
  if (!overridePool) {
    await saveOpenIpfOverridesToFile();
    return;
  }

  const key = getOpenIpfOverrideKey(name, club);
  const entry = getOpenIpfOverrideEntry(name, club);

  await overridePool.query(
    `
      INSERT INTO openipf_overrides (
        override_key,
        name,
        club,
        disambiguation_number,
        manual_slug,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (override_key)
      DO UPDATE SET
        name = EXCLUDED.name,
        club = EXCLUDED.club,
        disambiguation_number = EXCLUDED.disambiguation_number,
        manual_slug = EXCLUDED.manual_slug,
        updated_at = NOW()
    `,
    [
      key,
      String(name || "").trim(),
      String(club || "").trim(),
      entry.disambiguationNumber,
      entry.manualSlug
    ]
  );
}

function setOpenIpfOverride(name, club, override) {
  const key = getOpenIpfOverrideKey(name, club);
  openIpfOverrides[key] = {
    disambiguationNumber: normalizeDisambiguationNumber(override.disambiguationNumber),
    manualSlug: extractOpenIpfSlugFromInput(override.manualSlug)
  };
}

async function loadCache() {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    cache = {
      updatedAt: parsed.updatedAt || null,
      classes: {
        ...createEmptyClassMap(),
        ...(parsed.classes || {})
      }
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load cache", error);
    }
    cache = {
      updatedAt: null,
      classes: createEmptyClassMap()
    };
  }
}

async function loadOpenIpfCache() {
  try {
    const raw = await fs.readFile(OPENIPF_CACHE_FILE, "utf8");
    openIpfCache = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load OpenIPF cache", error);
    }
    openIpfCache = {};
  }
}

async function loadOpenIpfOverrides() {
  if (overridePool) {
    const result = await overridePool.query(
      `
        SELECT override_key, disambiguation_number, manual_slug
        FROM openipf_overrides
      `
    );

    openIpfOverrides = Object.fromEntries(
      result.rows.map((row) => [
        row.override_key,
        {
          disambiguationNumber: normalizeDisambiguationNumber(row.disambiguation_number),
          manualSlug: extractOpenIpfSlugFromInput(row.manual_slug)
        }
      ])
    );
    return;
  }

  try {
    const raw = await fs.readFile(OPENIPF_OVERRIDES_FILE, "utf8");
    openIpfOverrides = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Failed to load OpenIPF overrides", error);
    }
    openIpfOverrides = {};
  }
}

function isOpenIpfRecordFresh(record) {
  if (!record?.fetchedAt || record.version !== OPENIPF_CACHE_VERSION) {
    return false;
  }

  return Date.now() - new Date(record.fetchedAt).getTime() < OPENIPF_CACHE_TTL_MS;
}

function stripHtmlTags(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(html) {
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  const rowRegex = /<tr[\s\S]*?<\/tr>/gi;
  const cellRegex = /<(td|th)([^>]*)>([\s\S]*?)<\/\1>/gi;
  const tables = String(html || "").match(tableRegex) || [];

  return tables.map((tableHtml) => {
    const rows = tableHtml.match(rowRegex) || [];
    return rows.map((rowHtml) => {
      const cells = [];
      let match;

      while ((match = cellRegex.exec(rowHtml)) !== null) {
        const attributes = match[2] || "";
        const text = stripHtmlTags(match[3]);
        const colspanMatch = attributes.match(/colspan=["']?(\d+)/i);
        const colspan = colspanMatch ? Number(colspanMatch[1]) : 1;

        for (let index = 0; index < colspan; index += 1) {
          cells.push(text);
        }
      }

      return cells;
    });
  });
}

function parseDisambiguationCandidates(html) {
  const candidateRegex = /<h2>\s*<a href="\/u\/([^"]+)">([\s\S]*?)<\/a>\s*<\/h2>\s*(<table[\s\S]*?<\/table>)/gi;
  const candidates = [];
  let match;

  while ((match = candidateRegex.exec(String(html || ""))) !== null) {
    const slug = match[1];
    const title = stripHtmlTags(match[2]);
    const parsedTable = parseTables(match[3])[0] || [];
    const numberMatch = slug.match(/(\d+)$/);
    const number = numberMatch ? numberMatch[1] : null;

    if (!number) {
      continue;
    }

    candidates.push({
      number,
      slug,
      url: buildOpenIpfUrl(slug),
      title,
      headers: parsedTable[0] || [],
      rows: parsedTable.slice(1)
    });
  }

  return candidates;
}

function findHeaderIndexes(headers, headerName) {
  return headers.reduce((indexes, value, index) => {
    if (value.toLowerCase() === headerName) {
      indexes.push(index);
    }
    return indexes;
  }, []);
}

function hasMeaningfulValue(value) {
  const normalized = String(value || "").trim();
  return normalized !== "" && normalized !== "-";
}

function isFullMeetRow(headers, row) {
  const squatIndexes = findHeaderIndexes(headers, "squat");
  const benchIndexes = findHeaderIndexes(headers, "bench");
  const deadliftIndexes = findHeaderIndexes(headers, "deadlift");

  const hasSquat = squatIndexes.some((index) => hasMeaningfulValue(row[index]));
  const hasBench = benchIndexes.some((index) => hasMeaningfulValue(row[index]));
  const hasDeadlift = deadliftIndexes.some((index) => hasMeaningfulValue(row[index]));

  return hasSquat && hasBench && hasDeadlift;
}

function extractMostRecentTotal(competitionResultsTable) {
  if (!competitionResultsTable?.length) {
    return null;
  }

  const headers = competitionResultsTable[0] || [];
  const rows = competitionResultsTable.slice(1);
  const totalIndex = headers.findIndex((value) => value.toLowerCase() === "total");

  if (totalIndex < 0) {
    return null;
  }

  const firstFullMeetRow = rows.find((row) => {
    return hasMeaningfulValue(row[totalIndex]) && isFullMeetRow(headers, row);
  });

  if (firstFullMeetRow) {
    return firstFullMeetRow[totalIndex] || null;
  }

  const firstRowWithTotal = rows.find((row) => hasMeaningfulValue(row[totalIndex]));
  return firstRowWithTotal ? firstRowWithTotal[totalIndex] || null : null;
}

function extractOpenIpfStats(html) {
  if (/<title>\s*Disambiguation\s*<\/title>/i.test(html) || /<h1>\s*Lifter Disambiguation\s*<\/h1>/i.test(html)) {
    return {
      bestTotal: null,
      mostRecentTotal: null,
      profileFound: false,
      ambiguousProfile: true,
      disambiguationCandidates: parseDisambiguationCandidates(html)
    };
  }

  const tables = parseTables(html);
  const findTable = (requiredHeaders) => {
    return tables.find((rows) => {
      if (!rows.length) {
        return false;
      }

      const normalizedHeaders = rows[0].map((value) => value.toLowerCase());
      return requiredHeaders.every((header) => normalizedHeaders.includes(header));
    });
  };

  const personalBestsTable = findTable(["equip", "squat", "bench", "deadlift", "total"]);
  const competitionResultsTable = findTable(["date", "competition", "total"]);

  let bestTotal = null;
  let mostRecentTotal = null;

  if (personalBestsTable?.length > 1) {
    const totalIndex = personalBestsTable[0].findIndex((value) => value.toLowerCase() === "total");
    if (totalIndex >= 0) {
      bestTotal = personalBestsTable[1][totalIndex] || null;
    }
  }

  if (competitionResultsTable?.length > 1) {
    mostRecentTotal = extractMostRecentTotal(competitionResultsTable);
  }

  return {
    bestTotal,
    mostRecentTotal,
    profileFound: Boolean(personalBestsTable || competitionResultsTable),
    ambiguousProfile: false,
    disambiguationCandidates: []
  };
}

async function fetchOpenIpfStats(slug) {
  if (!slug) {
    return {
      openIpfSlug: "",
      openIpfUrl: null,
      bestTotal: null,
      mostRecentTotal: null,
      profileFound: false,
      ambiguousProfile: false,
      version: OPENIPF_CACHE_VERSION,
      fetchedAt: new Date().toISOString()
    };
  }

  const cached = openIpfCache[slug];
  if (isOpenIpfRecordFresh(cached)) {
    return cached;
  }

  if (openIpfRequests.has(slug)) {
    return openIpfRequests.get(slug);
  }

  const request = (async () => {
    const openIpfUrl = buildOpenIpfUrl(slug);
    const response = await fetch(openIpfUrl, {
      headers: {
        Accept: "text/html"
      }
    });

    if (response.status === 404) {
      const missingRecord = {
        openIpfSlug: slug,
        openIpfUrl,
        bestTotal: null,
        mostRecentTotal: null,
        profileFound: false,
        ambiguousProfile: false,
        disambiguationCandidates: [],
        version: OPENIPF_CACHE_VERSION,
        fetchedAt: new Date().toISOString()
      };
      openIpfCache[slug] = missingRecord;
      await saveOpenIpfCache();
      return missingRecord;
    }

    if (!response.ok) {
      throw new Error(`OpenIPF request failed for ${slug}: ${response.status}`);
    }

    const html = await response.text();
    const stats = extractOpenIpfStats(html);
    const nextRecord = {
      openIpfSlug: slug,
      openIpfUrl,
      bestTotal: stats.bestTotal,
      mostRecentTotal: stats.mostRecentTotal,
      profileFound: stats.profileFound,
      ambiguousProfile: stats.ambiguousProfile,
      disambiguationCandidates: stats.disambiguationCandidates || [],
      version: OPENIPF_CACHE_VERSION,
      fetchedAt: new Date().toISOString()
    };

    openIpfCache[slug] = nextRecord;
    await saveOpenIpfCache();
    return nextRecord;
  })();

  openIpfRequests.set(slug, request);

  try {
    return await request;
  } finally {
    openIpfRequests.delete(slug);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      await sleep(120);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function enrichEntriesWithOpenIpf(entries) {
  return mapWithConcurrency(entries, OPENIPF_CONCURRENCY, async (entry) => {
    const normalizedEntry = normalizeEntry(entry);
    const manualOpenIpfSlug = getManualOpenIpfSlug(normalizedEntry.name, normalizedEntry.club);
    const selectedDisambiguationNumber = getSelectedDisambiguationNumber(
      normalizedEntry.name,
      normalizedEntry.club
    );
    const lookupSlug = manualOpenIpfSlug || buildOpenIpfLookupSlug(
      normalizedEntry.openIpfBaseSlug,
      selectedDisambiguationNumber
    );
    let stats;

    try {
      stats = await fetchOpenIpfStats(lookupSlug);
    } catch (error) {
      console.error(`OpenIPF lookup failed for ${normalizedEntry.name}`, error);
      stats = {
        bestTotal: null,
        mostRecentTotal: null,
        profileFound: false,
        ambiguousProfile: false,
        disambiguationCandidates: []
      };
    }

    return {
      ...normalizedEntry,
      openIpfSlug: lookupSlug,
      openIpfUrl: buildOpenIpfUrl(lookupSlug),
      manualOpenIpfSlug,
      manualOpenIpfUrl: buildOpenIpfUrl(manualOpenIpfSlug),
      selectedDisambiguationNumber,
      bestTotal: stats.bestTotal,
      lastFullPowerTotal: stats.mostRecentTotal,
      mostRecentTotal: stats.mostRecentTotal,
      profileFound: stats.profileFound,
      ambiguousProfile: stats.ambiguousProfile,
      canResolveAmbiguity: Boolean(selectedDisambiguationNumber) || stats.ambiguousProfile,
      needsManualUrl: !stats.profileFound && !stats.ambiguousProfile,
      hasManualUrlOverride: Boolean(manualOpenIpfSlug)
    };
  });
}

async function fetchPage(weightClass, page) {
  const url = `${SPORT80_URL}&p=${page}&l=${PAGE_SIZE}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest"
    },
    body: JSON.stringify({
      columns: [],
      filters: { mg_489: [weightClass.id] }
    })
  });

  if (!response.ok) {
    throw new Error(`Sport80 request failed for ${weightClass.label}: ${response.status}`);
  }

  return response.json();
}

async function fetchEntriesForClass(weightClass) {
  const rows = [];
  let page = 0;
  let expectedTotal = null;

  while (true) {
    const payload = await fetchPage(weightClass, page);
    const pageRows = Array.isArray(payload?.data) ? payload.data.map(normalizeEntry) : [];

    rows.push(...pageRows);

    if (Number.isFinite(payload?.recordsFiltered)) {
      expectedTotal = payload.recordsFiltered;
    } else if (Number.isFinite(payload?.recordsTotal)) {
      expectedTotal = payload.recordsTotal;
    }

    if (expectedTotal !== null && rows.length >= expectedTotal) {
      break;
    }

    if (pageRows.length < PAGE_SIZE) {
      break;
    }

    page += 1;
    await sleep(150);
  }

  return uniqueEntries(rows)
    .filter((entry) => !isExcludedEntry(entry))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function refreshCache(force = false) {
  if (!force && hasUsableCache() && isCacheFresh()) {
    return cache;
  }

  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const nextCache = {
      updatedAt: new Date().toISOString(),
      classes: createEmptyClassMap()
    };

    for (const weightClass of weightClasses) {
      nextCache.classes[weightClass.label] = await fetchEntriesForClass(weightClass);
      await sleep(200);
    }

    cache = nextCache;
    await saveCache();
    scheduleCacheRefresh();
    return cache;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

app.get("/api/classes", async (_request, response) => {
  if (!hasUsableCache()) {
    await refreshCache(true);
  }

  response.json({
    classes: weightClasses,
    meta: getMeta()
  });
});

app.get("/api/entries", async (request, response) => {
  const selectedClass = String(request.query.weightClass || "");

  if (!selectedClass || !weightClasses.some((item) => item.label === selectedClass)) {
    response.status(400).json({ error: "Provide a valid weightClass query parameter." });
    return;
  }

  if (!hasUsableCache()) {
    await refreshCache(true);
  } else if (!isCacheFresh()) {
    refreshCache().catch((error) => {
      console.error("Background refresh failed", error);
    });
  }

  const rawEntries = (cache.classes[selectedClass] || [])
    .filter((entry) => !isExcludedEntry(entry))
    .map(normalizeEntry);
  const entries = (await enrichEntriesWithOpenIpf(rawEntries)).sort(compareEntriesByBestTotal);

  response.json({
    weightClass: selectedClass,
    entries,
    meta: getMeta()
  });
});

app.get("/api/status", (_request, response) => {
  response.json({
    cacheFresh: isCacheFresh(),
    refreshInProgress: Boolean(refreshPromise),
    meta: getMeta()
  });
});

app.get("/api/openipf/disambiguation", async (request, response) => {
  const name = String(request.query.name || "").trim();
  const club = String(request.query.club || "").trim();

  if (!name) {
    response.status(400).json({ error: "Provide a valid name query parameter." });
    return;
  }

  const baseSlug = normalizeOpenIpfSlug(name);
  const stats = await fetchOpenIpfStats(baseSlug);

  if (!stats.ambiguousProfile) {
    response.status(404).json({ error: "No OpenIPF disambiguation page found for this lifter." });
    return;
  }

  response.json({
    name,
    club,
    baseSlug,
    openIpfUrl: buildOpenIpfUrl(baseSlug),
    selectedDisambiguationNumber: getSelectedDisambiguationNumber(name, club),
    candidates: stats.disambiguationCandidates
  });
});

app.get("/api/openipf/manual-override", (request, response) => {
  const name = String(request.query.name || "").trim();
  const club = String(request.query.club || "").trim();

  if (!name) {
    response.status(400).json({ error: "Provide a valid name query parameter." });
    return;
  }

  const baseSlug = normalizeOpenIpfSlug(name);
  const manualSlug = getManualOpenIpfSlug(name, club);

  response.json({
    name,
    club,
    baseSlug,
    guessedUrl: buildOpenIpfUrl(baseSlug),
    manualOpenIpfSlug: manualSlug,
    manualOpenIpfUrl: buildOpenIpfUrl(manualSlug)
  });
});

app.post("/api/openipf/disambiguation", async (request, response) => {
  const name = String(request.body?.name || "").trim();
  const club = String(request.body?.club || "").trim();
  const disambiguationNumber = normalizeDisambiguationNumber(request.body?.disambiguationNumber);

  if (!name || !disambiguationNumber) {
    response.status(400).json({ error: "Provide name and a numeric disambiguationNumber." });
    return;
  }

  const baseSlug = normalizeOpenIpfSlug(name);
  const stats = await fetchOpenIpfStats(baseSlug);

  if (!stats.ambiguousProfile) {
    response.status(400).json({ error: "This lifter does not currently require disambiguation." });
    return;
  }

  const matchingCandidate = stats.disambiguationCandidates.find(
    (candidate) => candidate.number === disambiguationNumber
  );

  if (!matchingCandidate) {
    response.status(400).json({ error: "That disambiguation number does not exist on the OpenIPF page." });
    return;
  }

  const existingOverride = getOpenIpfOverrideEntry(name, club);
  setOpenIpfOverride(name, club, {
    disambiguationNumber,
    manualSlug: existingOverride.manualSlug
  });
  await saveOpenIpfOverride(name, club);

  const resolvedSlug = buildOpenIpfLookupSlug(baseSlug, disambiguationNumber);
  const resolvedStats = await fetchOpenIpfStats(resolvedSlug);

  response.json({
    ok: true,
    openIpfSlug: resolvedSlug,
    openIpfUrl: buildOpenIpfUrl(resolvedSlug),
    selectedDisambiguationNumber: disambiguationNumber,
    bestTotal: resolvedStats.bestTotal,
    lastFullPowerTotal: resolvedStats.mostRecentTotal,
    mostRecentTotal: resolvedStats.mostRecentTotal,
    profileFound: resolvedStats.profileFound
  });
});

app.post("/api/openipf/manual-override", async (request, response) => {
  const name = String(request.body?.name || "").trim();
  const club = String(request.body?.club || "").trim();
  const manualSlug = extractOpenIpfSlugFromInput(request.body?.openIpfUrl);

  if (!name || !manualSlug) {
    response.status(400).json({ error: "Provide name and a valid OpenIPF profile URL." });
    return;
  }

  const resolvedStats = await fetchOpenIpfStats(manualSlug);

  if (!resolvedStats.profileFound || resolvedStats.ambiguousProfile) {
    response.status(400).json({
      error: "The provided OpenIPF URL must point to a specific lifter profile, not a missing or disambiguation page."
    });
    return;
  }

  const existingOverride = getOpenIpfOverrideEntry(name, club);
  setOpenIpfOverride(name, club, {
    disambiguationNumber: existingOverride.disambiguationNumber,
    manualSlug
  });
  await saveOpenIpfOverride(name, club);

  response.json({
    ok: true,
    openIpfSlug: manualSlug,
    openIpfUrl: buildOpenIpfUrl(manualSlug),
    bestTotal: resolvedStats.bestTotal,
    lastFullPowerTotal: resolvedStats.mostRecentTotal,
    mostRecentTotal: resolvedStats.mostRecentTotal,
    profileFound: resolvedStats.profileFound
  });
});

app.post("/api/refresh", async (_request, response) => {
  try {
    const refreshed = await refreshCache(true);
    response.json({
      ok: true,
      updatedAt: refreshed.updatedAt,
      meta: getMeta()
    });
  } catch (error) {
    console.error("Manual refresh failed", error);
    response.status(500).json({ error: error.message || "Refresh failed." });
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: error.message || "Unexpected server error." });
});

async function start() {
  await loadCache();
  await loadOpenIpfCache();
  await initializeOpenIpfOverrideStore();
  await loadOpenIpfOverrides();

  if (process.argv.includes("--refresh-only")) {
    await refreshCache(true);
    console.log(`Cache refreshed at ${cache.updatedAt}`);
    return;
  }

  app.listen(PORT, () => {
    console.log(`BP web app running on http://localhost:${PORT}`);
  });

  scheduleCacheRefresh();

  if (!hasUsableCache()) {
    refreshCache(true).catch((error) => {
      console.error("Startup refresh failed", error);
    });
  }
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});