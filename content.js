(function () {
  const PANEL_ID = "instahyre-salary-panel";
  const LOGO_URL = chrome.runtime.getURL("icons/logo.svg");
  const HIDDEN_UI_SOURCES = new Set(["Glassdoor", "LeetCode"]);
  let latestRequestId = 0;
  let lastPayload = null;
  let currentJobId = null;

  function injectPageScript() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject.js");
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatSalaryValue(value) {
    if (value == null || value === "") return null;

    if (typeof value === "number") {
      if (value >= 100000) {
        return `₹${(value / 100000).toFixed(1)} LPA`;
      }
      return String(value);
    }

    if (typeof value === "object") {
      const min = value.min ?? value.minimum ?? value.salary_min ?? value.compensation_min;
      const max = value.max ?? value.maximum ?? value.salary_max ?? value.compensation_max;

      if (min != null && max != null) {
        return `${formatSalaryValue(min)} - ${formatSalaryValue(max)}`;
      }

      return JSON.stringify(value);
    }

    return String(value);
  }

  function buildSalaryLines(payload) {
    const lines = [];

    for (const field of payload.salaryFields || []) {
      const formatted = formatSalaryValue(field.value);
      if (!formatted) continue;

      const label = field.key
        .replace(/_/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());

      lines.push({ label, value: formatted });
    }

    return lines;
  }

  function buildMetricRows(data) {
    return [
      data.range
        ? `<div class="instahyre-salary-row"><span>Estimated range</span><strong>${escapeHtml(data.range)}</strong></div>`
        : "",
      data.average
        ? `<div class="instahyre-salary-row"><span>Average</span><strong>${escapeHtml(data.average)}</strong></div>`
        : "",
      data.reports
        ? `<div class="instahyre-salary-row"><span>Reports</span><strong>${escapeHtml(data.reports)}</strong></div>`
        : "",
      data.experience
        ? `<div class="instahyre-salary-row"><span>Experience</span><strong>${escapeHtml(data.experience)}</strong></div>`
        : "",
    ]
      .filter(Boolean)
      .join("");
  }

  function renderStructuredResult(result) {
    const source = result.source || "AmbitionBox";
    const company = result.company || {};
    const role = result.role || null;
    const requestedTitle = result.requestedTitle || "this role";

    const companyHasData = company.range || company.average || company.reports;
    const companyRows = companyHasData
      ? buildMetricRows(company)
      : company.noData
        ? `<p class="instahyre-salary-empty">${escapeHtml(result.companyName || "This company")} was found on ${escapeHtml(source)} but has no salary data published yet.</p>`
        : `<p class="instahyre-salary-empty">No company-wide salary data on ${escapeHtml(source)}.</p>`;

    const companySection = `
      <div class="instahyre-salary-section">
        <p class="instahyre-salary-section-title">Company overview · ${escapeHtml(source)}</p>
        ${companyRows}
        ${
          company.url
            ? `<a class="instahyre-salary-link" href="${escapeHtml(company.url)}" target="_blank" rel="noopener noreferrer">View all ${escapeHtml(result.companyName || "company")} salaries</a>`
            : ""
        }
      </div>
    `;

    let roleSection;
    if (role) {
      const similarNote = role.isExact
        ? ""
        : `<p class="instahyre-salary-note">Exact match for “${escapeHtml(requestedTitle)}” not found. Showing the closest related role.</p>`;
      const roleHeading = role.isExact
        ? escapeHtml(role.matchedName || requestedTitle)
        : `${escapeHtml(requestedTitle)} → ${escapeHtml(role.matchedName)}`;

      roleSection = `
        <div class="instahyre-salary-section">
          <p class="instahyre-salary-section-title">Role insight · ${roleHeading}</p>
          ${
            role.isExact
              ? ""
              : `<span class="instahyre-salary-badge">Closest match</span>`
          }
          ${similarNote}
          ${buildMetricRows(role)}
          ${
            role.url
              ? `<a class="instahyre-salary-link" href="${escapeHtml(role.url)}" target="_blank" rel="noopener noreferrer">View ${escapeHtml(role.matchedName || requestedTitle)} salaries</a>`
              : ""
          }
        </div>
      `;
    } else {
      roleSection = `
        <div class="instahyre-salary-section">
          <p class="instahyre-salary-section-title">Role insight · ${escapeHtml(requestedTitle)}</p>
          <p class="instahyre-salary-empty">No salary data for “${escapeHtml(requestedTitle)}” (or a closely related role) was found on ${escapeHtml(source)} for this company. Showing company-wide numbers above as a baseline.</p>
          ${
            company.url
              ? `<a class="instahyre-salary-link" href="${escapeHtml(company.url)}" target="_blank" rel="noopener noreferrer">Browse roles on ${escapeHtml(source)}</a>`
              : ""
          }
        </div>
      `;
    }

    return `${roleSection}${companySection}`;
  }

  function renderExternalSection(externalResult, loading) {
    if (loading) {
      return `
        <div class="instahyre-salary-section">
          <p class="instahyre-salary-section-title">Market salary lookup</p>
          <p class="instahyre-salary-loading">Checking AmbitionBox…</p>
        </div>
      `;
    }

    if (!externalResult) return "";

    if (externalResult.needsPageReload) {
      return `
        <div class="instahyre-salary-section">
          <p class="instahyre-salary-section-title">Market salary lookup</p>
          <div class="instahyre-salary-auth">
            <p class="instahyre-salary-auth-title">Extension updated</p>
            <p class="instahyre-salary-auth-copy">
              The extension was reloaded while this page was open. Refresh this Instahyre tab to reconnect, then click a job again.
            </p>
            <div class="instahyre-salary-auth-actions">
              <button type="button" class="instahyre-salary-button" data-action="reload-page">Refresh page</button>
            </div>
          </div>
        </div>
      `;
    }

    if (externalResult.found) {
      if (externalResult.company || externalResult.role || externalResult.roleNotFound) {
        return renderStructuredResult(externalResult);
      }

      const rows = buildMetricRows(externalResult);

      return `
        <div class="instahyre-salary-section">
          <p class="instahyre-salary-section-title">Market salary · ${escapeHtml(externalResult.source)}</p>
          ${rows}
          ${
            externalResult.note
              ? `<p class="instahyre-salary-note">${escapeHtml(externalResult.note)}</p>`
              : ""
          }
          ${
            externalResult.url
              ? `<a class="instahyre-salary-link" href="${escapeHtml(externalResult.url)}" target="_blank" rel="noopener noreferrer">View on ${escapeHtml(externalResult.source)}</a>`
              : ""
          }
        </div>
      `;
    }

    const attempts = (externalResult.attempts || [])
      .filter((attempt) => !HIDDEN_UI_SOURCES.has(attempt.split(":")[0]?.trim()))
      .map((attempt) => `<li>${escapeHtml(attempt)}</li>`)
      .join("");

    const links = externalResult.links || {};
    const linkRows = [
      links.ambitionbox
        ? `<a class="instahyre-salary-link" href="${escapeHtml(links.ambitionbox)}" target="_blank" rel="noopener noreferrer">Search AmbitionBox</a>`
        : "",
    ]
      .filter(Boolean)
      .join("");

    const authBanner = externalResult.needsAmbitionBoxLogin
      ? `
        <div class="instahyre-salary-auth">
          <p class="instahyre-salary-auth-title">AmbitionBox sign-in required</p>
          <p class="instahyre-salary-auth-copy">
            Sign in to AmbitionBox in Chrome, keep that tab open or let the extension open one in the background, then retry.
          </p>
          <div class="instahyre-salary-auth-actions">
            <a
              class="instahyre-salary-button"
              href="${escapeHtml(externalResult.ambitionBoxLoginUrl || "https://www.ambitionbox.com/login")}"
              target="_blank"
              rel="noopener noreferrer"
            >Sign in to AmbitionBox</a>
            <button type="button" class="instahyre-salary-button instahyre-salary-button-secondary" data-action="retry-salary">
              Retry lookup
            </button>
          </div>
        </div>
      `
      : externalResult.ambitionBoxSessionExpired
        ? `
        <div class="instahyre-salary-auth">
          <p class="instahyre-salary-auth-title">AmbitionBox session issue</p>
          <p class="instahyre-salary-auth-copy">
            You appear signed in, but AmbitionBox still blocked the request. Open AmbitionBox in a tab, refresh it, then retry.
          </p>
          <div class="instahyre-salary-auth-actions">
            <a
              class="instahyre-salary-button"
              href="https://www.ambitionbox.com/salaries"
              target="_blank"
              rel="noopener noreferrer"
            >Open AmbitionBox</a>
            <button type="button" class="instahyre-salary-button instahyre-salary-button-secondary" data-action="retry-salary">
              Retry lookup
            </button>
          </div>
        </div>
      `
        : "";

    return `
      <div class="instahyre-salary-section">
        <p class="instahyre-salary-section-title">Market salary lookup</p>
        <p class="instahyre-salary-empty">No reliable salary range found automatically for this company and role.</p>
        ${authBanner}
        ${attempts ? `<ul class="instahyre-salary-attempts">${attempts}</ul>` : ""}
        <div class="instahyre-salary-links">${linkRows}</div>
      </div>
    `;
  }

  function renderPanel(payload, externalResult, loadingExternal) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("section");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }

    const salaryLines = buildSalaryLines(payload);
    const glassdoorRating = payload.glassdoor?.compensation_benefits;
    const companyName = payload.companyName || "";
    const jobTitle = payload.jobTitle || "";

    const salaryHtml =
      salaryLines.length > 0
        ? salaryLines
            .map(
              (line) =>
                `<div class="instahyre-salary-row"><span>${escapeHtml(line.label)}</span><strong>${escapeHtml(line.value)}</strong></div>`
            )
            .join("")
        : "";

    const metaParts = [
      payload.experience ? `Experience: ${payload.experience}` : null,
      Array.isArray(payload.locations)
        ? `Location: ${payload.locations.join(", ")}`
        : null,
    ].filter(Boolean);

    const benefits =
      Array.isArray(payload.benefits) && payload.benefits.length
        ? `<div class="instahyre-salary-row"><span>Benefits</span><strong>${escapeHtml(payload.benefits.join(", "))}</strong></div>`
        : "";

    const instahyreRating =
      glassdoorRating != null
        ? `<div class="instahyre-salary-row"><span>Instahyre compensation rating</span><strong>${escapeHtml(glassdoorRating)}/5</strong></div>`
        : "";

    const instahyreSection = (instahyreRating || salaryHtml || benefits)
      ? `<div class="instahyre-salary-section">
           <p class="instahyre-salary-section-title">Instahyre API fields</p>
           ${salaryHtml}
           ${instahyreRating}
           ${benefits}
         </div>`
      : "";

    panel.innerHTML = `
      <button type="button" class="instahyre-salary-close" aria-label="Close">×</button>
      <div class="instahyre-salary-header">
        <div class="instahyre-salary-brand">
          <img class="instahyre-salary-logo" src="${LOGO_URL}" alt="" width="32" height="32" />
          <p class="instahyre-salary-kicker">Instahyre Salary Insight</p>
        </div>
        <h3>${companyName && jobTitle ? `${escapeHtml(companyName)} · ${escapeHtml(jobTitle)}` : escapeHtml(companyName || jobTitle || "—")}</h3>
        ${metaParts.length ? `<p class="instahyre-salary-meta">${escapeHtml(metaParts.join(" · "))}</p>` : ""}
      </div>
      <div class="instahyre-salary-body">
        ${renderExternalSection(externalResult, loadingExternal)}
        ${instahyreSection}
      </div>
    `;

    panel.querySelector(".instahyre-salary-close").addEventListener("click", () => {
      panel.remove();
    });

    const retryButton = panel.querySelector('[data-action="retry-salary"]');
    if (retryButton && lastPayload) {
      retryButton.addEventListener("click", () => {
        fetchExternalSalary(lastPayload);
      });
    }

    const reloadButton = panel.querySelector('[data-action="reload-page"]');
    if (reloadButton) {
      reloadButton.addEventListener("click", () => {
        window.location.reload();
      });
    }
  }

  function isExtensionContextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (error) {
      return false;
    }
  }

  async function fetchExternalSalary(payload) {
    const requestId = ++latestRequestId;
    lastPayload = payload;

    renderPanel(payload, null, true);

    if (!isExtensionContextAlive()) {
      renderPanel(payload, { found: false, needsPageReload: true }, false);
      return;
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "FETCH_EXTERNAL_SALARY",
        payload: {
          companyName: payload.companyName,
          jobTitle: payload.jobTitle,
          location: Array.isArray(payload.locations) ? payload.locations[0] : null,
        },
      });

      if (requestId !== latestRequestId) return;

      if (!response?.ok) {
        renderPanel(payload, { found: false, attempts: [response?.error || "Lookup failed"] }, false);
        return;
      }

      renderPanel(payload, response.result, false);
    } catch (error) {
      if (requestId !== latestRequestId) return;

      if (/Extension context invalidated|message port closed|receiving end does not exist/i.test(error.message)) {
        renderPanel(payload, { found: false, needsPageReload: true }, false);
        return;
      }

      renderPanel(payload, { found: false, attempts: [error.message] }, false);
    }
  }

  injectPageScript();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "INSTAHYRE_SALARY_DATA") return;

    const payload = event.data.payload;

    // Skip payloads that have no real job context (e.g. list refreshes, "not interested" responses)
    if (!payload?.companyName || !payload?.jobTitle) return;

    // Skip if this is the same job we already looked up
    const incomingId = payload.jobId ?? null;
    if (incomingId && incomingId === currentJobId) return;

    currentJobId = incomingId;
    fetchExternalSalary(payload);
  });
})();
