const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
  ];

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

async function fetchAmbitionBoxSalary({ companyName, jobTitle, location }) {
  const company = await searchAmbitionBoxCompany(companyName);
  if (!company?.url) return null;

  const companyPage = await fetchAmbitionBoxPage(
    `https://www.ambitionbox.com/salaries/${company.url}-salaries`
  );
  const pageProps = companyPage?.props?.pageProps;
  if (!pageProps) return null;

  const roleCandidates = await buildAmbitionBoxRoleCandidates(jobTitle, pageProps.jobProfiles);
  let bestRoleResult = null;

  for (const roleSlug of roleCandidates) {
    const rolePage = await fetchAmbitionBoxPage(
      `https://www.ambitionbox.com/salaries/${company.url}-salaries/${roleSlug}`
    );
    const roleSummary = rolePage?.props?.pageProps?.salaryData?.data?.summaryData;
    const parsed = parseAmbitionBoxSummary(roleSummary, roleSlug);

    if (parsed?.hasRoleRange) {
      bestRoleResult = {
        ...parsed,
        roleSlug,
        roleName: rolePage?.props?.pageProps?.salaryData?.data?.profileInfo?.profileName || roleSlug,
      };
      break;
    }
  }

  if (bestRoleResult) {
    return {
      found: true,
      source: "AmbitionBox",
      companyName: pageProps.companyName || company.name,
      jobTitle: bestRoleResult.roleName || jobTitle,
      range: bestRoleResult.range,
      average: bestRoleResult.average,
      reports: bestRoleResult.reports,
      experience: bestRoleResult.experience,
      location: location || null,
      url: `https://www.ambitionbox.com/salaries/${company.url}-salaries/${bestRoleResult.roleSlug}`,
      confidence: "high",
    };
  }

  const companySummary = parseAmbitionBoxSummary(pageProps.salariesSummaryData);
  if (!companySummary) return null;

  return {
    found: true,
    source: "AmbitionBox",
    companyName: pageProps.companyName || company.name,
    jobTitle,
    range: companySummary.range,
    average: companySummary.average,
    reports: companySummary.reports,
    location: location || null,
    url: `https://www.ambitionbox.com/salaries/${company.url}-salaries`,
    note: "Company-wide average on AmbitionBox (role-specific data not found).",
    confidence: "medium",
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
  const candidates = new Set();
  candidates.add(slugify(jobTitle));

  const profileSearch = await fetchJson(
    `https://www.ambitionbox.com/api/v2/search?query=${encodeURIComponent(jobTitle)}&category=jobProfile`
  );

  for (const item of profileSearch?.data || []) {
    if (item.UrlName) candidates.add(item.UrlName);
  }

  const rankedProfiles = rankProfiles(jobTitle, jobProfiles || []);
  for (const profile of rankedProfiles.slice(0, 5)) {
    if (profile.urlName) candidates.add(profile.urlName);
  }

  return [...candidates].filter(Boolean);
}

async function fetchAmbitionBoxPage(url) {
  const html = await fetchText(url, { site: "ambitionbox" });
  return parseNextData(html);
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

function rankProfiles(jobTitle, profiles) {
  const target = normalizeText(jobTitle);

  return [...profiles]
    .map((profile) => {
      const slug = profile.urlName || "";
      const score = similarityScore(target, normalizeText(slug.replace(/-/g, " ")));
      return { ...profile, score };
    })
    .sort((a, b) => b.score - a.score);
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
  const response = await fetch(url, {
    headers: buildHeaders(site),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: buildHeaders("ambitionbox"),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function buildHeaders(site) {
  const headers = {
    accept: "text/html,application/json,*/*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": USER_AGENT,
  };

  if (site === "ambitionbox") {
    headers.accept = "application/json, text/plain, */*";
  }

  return headers;
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
  return entry;
}

async function writeCache(key, value) {
  const storageKey = `salary:${key}`;
  await chrome.storage.local.set({ [storageKey]: value });
}

function slugify(value) {
  return normalizeText(value).replace(/\s+/g, "-");
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
