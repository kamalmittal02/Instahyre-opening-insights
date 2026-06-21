const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PROVIDERS_ENABLED = {
  Glassdoor: false,
  AmbitionBox: true,
  LeetCode: false,
};
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const AMBITIONBOX_LOGIN_URL = "https://www.ambitionbox.com/login";
const AMBITIONBOX_ORIGIN = "https://www.ambitionbox.com";
const AMBITIONBOX_TAB_URL = `${AMBITIONBOX_ORIGIN}/salaries`;

let cachedAmbitionBoxBuildId = null;
let ambitionBoxTabPromise = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "CHECK_AMBITIONBOX_AUTH") {
    checkAmbitionBoxAuth()
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type !== "FETCH_EXTERNAL_SALARY") return;

  fetchExternalSalary(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

async function fetchExternalSalary(payload) {
  const cacheKey = buildCacheKey(payload);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  const providers = [
    { name: "Glassdoor", fetch: fetchGlassdoorSalary },
    { name: "AmbitionBox", fetch: fetchAmbitionBoxSalary },
    { name: "LeetCode", fetch: fetchLeetCodeSalary },
  ].filter((provider) => PROVIDERS_ENABLED[provider.name]);

  const attempts = [];

  for (const provider of providers) {
    try {
      const result = await provider.fetch(payload);
      if (result) {
        const enriched = { ...result, provider: provider.name, fetchedAt: Date.now() };
        await writeCache(cacheKey, enriched);
        return enriched;
      }
      attempts.push(`${provider.name}: no matching salary data`);
    } catch (error) {
      attempts.push(`${provider.name}: ${error.message}`);
    }
  }

  return {
    provider: null,
    found: false,
    attempts,
    links: buildSearchLinks(payload),
    needsAmbitionBoxLogin: await shouldPromptAmbitionBoxLogin(attempts),
    ambitionBoxSessionExpired: await shouldShowAmbitionBoxSessionHint(attempts),
    ambitionBoxLoginUrl: AMBITIONBOX_LOGIN_URL,
  };
}

async function fetchGlassdoorSalary({ companyName, jobTitle }) {
  const searchUrl = `https://www.glassdoor.co.in/Salary/${slugify(companyName)}-salaries-SRCH_KO0,${encodeURIComponent(companyName).replace(/%20/g, "%20")}.htm`;
  const html = await fetchText(searchUrl, { site: "glassdoor" });

  const titlePattern = escapeRegExp(jobTitle);
  const scopedSection =
    html.match(new RegExp(`${titlePattern}[\\s\\S]{0,1200}`, "i"))?.[0] || html;

  const rangeMatch =
    scopedSection.match(
      /(?:₹|INR\s*)?(\d+(?:\.\d+)?)\s*(?:LPA|L|lakhs?)[\s–-]+(?:₹|INR\s*)?(\d+(?:\.\d+)?)\s*(?:LPA|L|lakhs?)/i
    ) ||
    html.match(
      /(?:₹|INR\s*)?(\d+(?:\.\d+)?)\s*(?:LPA|L|lakhs?)[\s–-]+(?:₹|INR\s*)?(\d+(?:\.\d+)?)\s*(?:LPA|L|lakhs?)/i
    );

  const averageMatch =
    scopedSection.match(/average[^₹\\d]{0,20}(?:₹|INR\s*)?(\d+(?:\.\d+)?)\s*(?:LPA|L|lakhs?)/i) ||
    html.match(/average[^₹\\d]{0,20}(?:₹|INR\s*)?(\d+(?:\.\d+)?)\s*(?:LPA|L|lakhs?)/i);

  if (!rangeMatch && !averageMatch) {
    return null;
  }

  return {
    found: true,
    source: "Glassdoor",
    companyName,
    jobTitle,
    range: rangeMatch
      ? `${formatLpa(rangeMatch[1])} - ${formatLpa(rangeMatch[2])}`
      : null,
    average: averageMatch ? formatLpa(averageMatch[1]) : null,
    reports: extractFirstNumber(scopedSection.match(/(\d[\d,]*)\s+salaries?/i)?.[1]),
    url: searchUrl,
    confidence: rangeMatch ? "medium" : "low",
  };
}

const AMBITIONBOX_ROLE_SIMILARITY_THRESHOLD = 0.3;
const AMBITIONBOX_MAX_ROLE_LOOKUPS = 8;

async function fetchAmbitionBoxSalary({ companyName, jobTitle, location }) {
  const company = await searchAmbitionBoxCompany(companyName);
  if (!company?.url) return null;

  const companyUrl = `https://www.ambitionbox.com/salaries/${company.url}-salaries`;

  // Fetch company overview — null on 404 (company exists in search but has no salary page yet)
  const companyPage = await fetchAmbitionBoxPage(companyUrl);
  const pageProps = companyPage?.props?.pageProps ?? null;

  const resolvedCompanyName = pageProps?.companyName || company.name;
  const companySummary = pageProps ? parseAmbitionBoxSummary(pageProps.salariesSummaryData) : null;
  const normalizedTitle = normalizeText(jobTitle);

  // Build role candidates from page's jobProfiles (may be empty if page 404'd) + API search
  const roleCandidates = await buildAmbitionBoxRoleCandidates(jobTitle, pageProps?.jobProfiles || []);

  let exactRole = null;
  let similarRole = null;

  for (const candidate of roleCandidates.slice(0, AMBITIONBOX_MAX_ROLE_LOOKUPS)) {
    // fetchAmbitionBoxPage returns null on 404 — skip gracefully
    const rolePage = await fetchAmbitionBoxPage(`${companyUrl}/${candidate.slug}`);
    if (!rolePage) continue;

    const data = rolePage?.props?.pageProps?.salaryData?.data;
    const parsed = parseAmbitionBoxSummary(data?.summaryData, candidate.slug);
    if (!parsed?.hasRoleRange && !parsed?.average) continue;

    const matchedName = data?.profileInfo?.profileName || titleCase(candidate.slug);
    const isExact =
      normalizeText(matchedName) === normalizedTitle ||
      normalizeText(candidate.slug.replace(/-/g, " ")) === normalizedTitle;
    const isRelated =
      isExact || candidate.fromSearch || candidate.score >= AMBITIONBOX_ROLE_SIMILARITY_THRESHOLD;

    const roleResult = {
      matchedName,
      isExact,
      range: parsed.range,
      average: parsed.average,
      reports: parsed.reports,
      experience: parsed.experience,
      url: `${companyUrl}/${candidate.slug}`,
    };

    if (isExact) {
      exactRole = roleResult;
      break;
    }

    if (isRelated && !similarRole) {
      similarRole = roleResult;
    }
  }

  const role = exactRole || similarRole;

  // Return null only if both company page AND role lookup are completely empty
  if (!companySummary && !role && !pageProps) {
    // Company page 404'd and role search also empty — provide a minimal result with link
    // so the user at least gets the "not found" UI with the correct AmbitionBox link
    const titleSlug = slugify(jobTitle);
    return {
      found: true,
      source: "AmbitionBox",
      companyName: resolvedCompanyName,
      requestedTitle: jobTitle,
      location: location || null,
      company: { range: null, average: null, reports: null, url: companyUrl, noData: true },
      role: null,
      roleNotFound: true,
      url: `${companyUrl}/${titleSlug}`,
      confidence: "low",
    };
  }

  if (!companySummary && !role) return null;

  return {
    found: true,
    source: "AmbitionBox",
    companyName: resolvedCompanyName,
    requestedTitle: jobTitle,
    location: location || null,
    company: {
      range: companySummary?.range || null,
      average: companySummary?.average || null,
      reports: companySummary?.reports || null,
      url: companyUrl,
      noData: !companySummary,
    },
    role: role
      ? {
          requestedTitle: jobTitle,
          matchedName: role.matchedName,
          isExact: role.isExact,
          range: role.range,
          average: role.average,
          reports: role.reports,
          experience: role.experience,
          url: role.url,
        }
      : null,
    roleNotFound: !role,
    url: role?.url || companyUrl,
    confidence: role ? (role.isExact ? "high" : "medium") : "medium",
  };
}

async function fetchLeetCodeSalary({ companyName, jobTitle }) {
  const query = encodeURIComponent(`${companyName} ${jobTitle} salary`);
  const url = `https://leetcode.com/discuss/search?query=${query}&currentPage=1&orderBy=hot`;
  const html = await fetchText(url, { site: "leetcode" });
  const plainText = decodeHtml(html).replace(/\s+/g, " ");

  const companyPattern = escapeRegExp(companyName);
  const snippets = plainText.match(
    new RegExp(`[^.]{0,80}${companyPattern}[^.]{0,180}`, "gi")
  );

  const salaryPattern =
    /(?:₹\s*)?(\d+(?:\.\d+)?)\s*(?:LPA|L|lakhs?)(?:\s*(?:-|to|–)\s*(?:₹\s*)?(\d+(?:\.\d+)?)\s*(?:LPA|L|lakhs?))?/gi;

  for (const snippet of snippets || []) {
    const matches = [...snippet.matchAll(salaryPattern)];
    if (!matches.length) continue;

    const first = matches[0];
    return {
      found: true,
      source: "LeetCode",
      companyName,
      jobTitle,
      range: first[2]
        ? `${formatLpa(first[1])} - ${formatLpa(first[2])}`
        : formatLpa(first[1]),
      average: null,
      reports: null,
      url,
      note: "Parsed from LeetCode discuss search results.",
      confidence: "low",
    };
  }

  return null;
}

async function searchAmbitionBoxCompany(companyName) {
  const response = await fetchJson(
    `https://www.ambitionbox.com/api/v2/search?query=${encodeURIComponent(companyName)}&category=company`
  );

  const results = response?.data || [];
  if (!results.length) return null;

  const normalizedTarget = normalizeText(companyName);
  return (
    results.find((item) => normalizeText(item.name) === normalizedTarget) ||
    results.find((item) => normalizeText(item.name).includes(normalizedTarget)) ||
    results[0]
  );
}

async function buildAmbitionBoxRoleCandidates(jobTitle, jobProfiles) {
  const normalizedTitle = normalizeText(jobTitle);
  const candidates = new Map();

  const addCandidate = (slug, fromSearch) => {
    if (!slug) return;
    const score = similarityScore(normalizedTitle, normalizeText(slug.replace(/-/g, " ")));
    const existing = candidates.get(slug);
    if (!existing) {
      candidates.set(slug, { slug, fromSearch, score });
    } else if (fromSearch) {
      existing.fromSearch = true;
    }
  };

  addCandidate(slugify(jobTitle), true);

  const profileSearch = await fetchJson(
    `https://www.ambitionbox.com/api/v2/search?query=${encodeURIComponent(jobTitle)}&category=jobProfile`
  );
  for (const item of profileSearch?.data || []) {
    addCandidate(item.UrlName, true);
  }

  for (const profile of jobProfiles || []) {
    addCandidate(profile.urlName, false);
  }

  return [...candidates.values()].sort((a, b) => {
    if (a.fromSearch !== b.fromSearch) return a.fromSearch ? -1 : 1;
    return b.score - a.score;
  });
}

async function fetchAmbitionBoxPage(url) {
  const path = new URL(url).pathname.replace(/\/$/, "");
  const buildId = await getAmbitionBoxBuildId();

  if (buildId) {
    try {
      const data = await fetchAmbitionBoxNextData(`/_next/data/${buildId}${path}.json`);
      if (data?.pageProps) {
        return { props: { pageProps: data.pageProps }, buildId: data.buildId || buildId };
      }
    } catch (error) {
      if (isAuthError(error)) throw error;
      // 404 or other non-auth errors → fall through to HTML fetch
    }
  }

  try {
    const html = await fetchText(url, { site: "ambitionbox" });
    const nextData = parseNextData(html);
    if (nextData?.buildId) {
      await storeAmbitionBoxBuildId(nextData.buildId);
    }
    return nextData;
  } catch (error) {
    if (isAuthError(error)) throw error;
    // 404 / page doesn't exist on AmbitionBox → treat as no data
    return null;
  }
}

function parseAmbitionBoxSummary(summary, roleSlug) {
  if (!summary) return null;

  const min = Number(summary.minCtc ?? summary.typicalMinCtc);
  const max = Number(summary.maxCtc ?? summary.typicalMaxCtc);
  const average = Number(summary.totalSalaryAverage ?? summary.averageCtc);
  const reports = Number(summary.totalSalaryDataPoints ?? summary.dataPoints);
  const hasRoleRange = Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0;

  return {
    range: hasRoleRange ? `${formatInr(min)} - ${formatInr(max)}` : null,
    average: Number.isFinite(average) ? formatAmount(average) : null,
    reports: Number.isFinite(reports) ? reports : null,
    experience:
      summary.minExp != null && summary.maxExp != null
        ? `${summary.minExp} - ${summary.maxExp} years`
        : null,
    hasRoleRange,
    roleSlug,
  };
}

function parseNextData(html) {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) return null;

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    return null;
  }
}

async function fetchText(url, { site }) {
  if (site === "ambitionbox") {
    return fetchAmbitionBoxViaBridge(url, { json: false });
  }

  const response = await fetch(url, {
    headers: await buildHeaders(site),
    redirect: "follow",
  });

  if (!response.ok) {
    throw createHttpError(response.status, site);
  }

  return response.text();
}

async function fetchJson(url) {
  return fetchAmbitionBoxViaBridge(url, { json: true });
}

async function fetchAmbitionBoxNextData(path) {
  return fetchAmbitionBoxViaBridge(`${AMBITIONBOX_ORIGIN}${path}`, {
    json: true,
    headers: { "x-nextjs-data": "1" },
  });
}

async function fetchAmbitionBoxViaBridge(url, { json = false, headers = {} } = {}) {
  const tabId = await ensureAmbitionBoxTab();
  const response = await runAmbitionBoxFetch(tabId, { url, json, headers });

  if (!response) {
    throw new Error("AmbitionBox bridge unavailable. Reload the extension and try again.");
  }

  if (response.error) {
    throw new Error(response.error);
  }

  if (!response.ok) {
    throw createHttpError(response.status || 0, "ambitionbox");
  }

  return response.body;
}

async function runAmbitionBoxFetch(tabId, { url, json, headers }, attempt = 0) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [url, json, headers],
      func: async (fetchUrl, asJson, extraHeaders) => {
        try {
          const res = await fetch(fetchUrl, {
            method: "GET",
            credentials: "include",
            headers: {
              accept: asJson
                ? "application/json, text/plain, */*"
                : "text/html,application/json,*/*",
              ...(extraHeaders || {}),
            },
          });

          const body = asJson ? await res.json() : await res.text();
          return { ok: res.ok, status: res.status, body };
        } catch (err) {
          return { ok: false, status: 0, error: String(err && err.message ? err.message : err) };
        }
      },
    });

    return results?.[0]?.result || null;
  } catch (error) {
    if (attempt >= 2) {
      throw new Error("AmbitionBox bridge unavailable. Reload the extension and try again.");
    }

    await delay(600);
    return runAmbitionBoxFetch(tabId, { url, json, headers }, attempt + 1);
  }
}

async function ensureAmbitionBoxTab() {
  if (ambitionBoxTabPromise) {
    return ambitionBoxTabPromise;
  }

  ambitionBoxTabPromise = (async () => {
    const existingTabs = await chrome.tabs.query({
      url: ["https://www.ambitionbox.com/*", "https://ambitionbox.com/*"],
    });

    if (existingTabs.length) {
      return existingTabs[0].id;
    }

    const tab = await chrome.tabs.create({
      url: AMBITIONBOX_TAB_URL,
      active: false,
    });

    await waitForTabComplete(tab.id);
    await delay(400);
    return tab.id;
  })();

  try {
    return await ambitionBoxTabPromise;
  } finally {
    ambitionBoxTabPromise = null;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve();
        return;
      }

      if (tab?.status === "complete") {
        resolve();
        return;
      }

      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildHeaders(site) {
  const headers = {
    accept: "text/html,application/json,*/*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": USER_AGENT,
  };

  if (site === "glassdoor") {
    headers.accept = "text/html,application/json,*/*";
  }

  return headers;
}

async function getAmbitionBoxCookies() {
  const byUrl = await chrome.cookies.getAll({ url: `${AMBITIONBOX_ORIGIN}/` });
  if (byUrl.length) return byUrl;

  return chrome.cookies.getAll({ domain: ".ambitionbox.com" });
}

async function isAmbitionBoxAuthenticated() {
  const cookies = await getAmbitionBoxCookies();
  return cookies.some(
    (cookie) =>
      (cookie.name === "AT" || cookie.name === "RT" || cookie.name === "UAC_I") && cookie.value
  );
}

async function checkAmbitionBoxAuth() {
  const authenticated = await isAmbitionBoxAuthenticated();
  return {
    authenticated,
    loginUrl: AMBITIONBOX_LOGIN_URL,
  };
}

async function shouldPromptAmbitionBoxLogin(attempts) {
  const ambitionBoxFailed = attempts.some(
    (attempt) => attempt.startsWith("AmbitionBox:") && /HTTP 40[13]/.test(attempt)
  );
  if (!ambitionBoxFailed) return false;

  const authenticated = await isAmbitionBoxAuthenticated();
  return !authenticated;
}

async function shouldShowAmbitionBoxSessionHint(attempts) {
  const ambitionBoxFailed = attempts.some(
    (attempt) => attempt.startsWith("AmbitionBox:") && /HTTP 40[13]/.test(attempt)
  );
  if (!ambitionBoxFailed) return false;

  return await isAmbitionBoxAuthenticated();
}

function createHttpError(status, site) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  error.site = site;
  return error;
}

function isAuthError(error) {
  return error?.site === "ambitionbox" && (error.status === 401 || error.status === 403);
}

async function getAmbitionBoxBuildId() {
  if (cachedAmbitionBoxBuildId) return cachedAmbitionBoxBuildId;

  const stored = await chrome.storage.local.get("ambitionboxBuildId");
  if (stored.ambitionboxBuildId) {
    cachedAmbitionBoxBuildId = stored.ambitionboxBuildId;
    return cachedAmbitionBoxBuildId;
  }

  try {
    const html = await fetchAmbitionBoxViaBridge(AMBITIONBOX_TAB_URL, { json: false });
    const nextData = parseNextData(html);
    if (nextData?.buildId) {
      await storeAmbitionBoxBuildId(nextData.buildId);
      return nextData.buildId;
    }
  } catch (error) {
    if (isAuthError(error)) throw error;
  }

  return null;
}

async function storeAmbitionBoxBuildId(buildId) {
  cachedAmbitionBoxBuildId = buildId;
  await chrome.storage.local.set({ ambitionboxBuildId: buildId });
}

function buildSearchLinks({ companyName, jobTitle }) {
  const companySlug = slugify(companyName);
  const titleSlug = slugify(jobTitle);

  return {
    glassdoor: `https://www.glassdoor.co.in/Salary/${companySlug}-salaries-SRCH_KO0,${encodeURIComponent(companyName)}.htm`,
    ambitionbox: `https://www.ambitionbox.com/salaries/${companySlug}-salaries/${titleSlug}`,
    leetcode: `https://leetcode.com/discuss/search?query=${encodeURIComponent(`${companyName} ${jobTitle} salary`)}`,
  };
}

function buildCacheKey({ companyName, jobTitle, location }) {
  return `${normalizeText(companyName)}|${normalizeText(jobTitle)}|${normalizeText(location || "")}`;
}

async function readCache(key) {
  const storageKey = `salary:${key}`;
  const stored = await chrome.storage.local.get(storageKey);
  const entry = stored[storageKey];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
  if (entry.provider && !PROVIDERS_ENABLED[entry.provider]) return null;
  if (entry.source && !PROVIDERS_ENABLED[entry.source]) return null;
  return entry;
}

async function writeCache(key, value) {
  const storageKey = `salary:${key}`;
  await chrome.storage.local.set({ [storageKey]: value });
}

function slugify(value) {
  return normalizeText(value)
    .replace(/\s+-\s+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

function titleCase(value) {
  return String(value || "")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarityScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;

  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return union ? intersection / union : 0;
}

function formatAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (amount > 0 && amount < 1000) return `₹${amount.toFixed(1)} LPA`;
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(1)} LPA`;
  if (amount >= 1000) return `₹${Math.round(amount / 100000)} LPA`;
  return `₹${amount}`;
}

function formatInr(value) {
  return formatAmount(value);
}

function formatLpa(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return String(value);
  return `₹${amount} LPA`;
}

function extractFirstNumber(value) {
  if (!value) return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
}
