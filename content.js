(function () {
  const PANEL_ID = "instahyre-salary-panel";
  let latestRequestId = 0;

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

  function renderExternalSection(externalResult, loading) {
    if (loading) {
      return `
        <div class="instahyre-salary-section">
          <p class="instahyre-salary-section-title">Market salary lookup</p>
          <p class="instahyre-salary-loading">Checking Glassdoor, AmbitionBox, and LeetCode…</p>
        </div>
      `;
    }

    if (!externalResult) return "";

    if (externalResult.found) {
      const rows = [
        externalResult.range
          ? `<div class="instahyre-salary-row"><span>Estimated range</span><strong>${escapeHtml(externalResult.range)}</strong></div>`
          : "",
        externalResult.average
          ? `<div class="instahyre-salary-row"><span>Average</span><strong>${escapeHtml(externalResult.average)}</strong></div>`
          : "",
        externalResult.reports
          ? `<div class="instahyre-salary-row"><span>Reports</span><strong>${escapeHtml(externalResult.reports)}</strong></div>`
          : "",
        externalResult.experience
          ? `<div class="instahyre-salary-row"><span>Experience</span><strong>${escapeHtml(externalResult.experience)}</strong></div>`
          : "",
      ]
        .filter(Boolean)
        .join("");

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
      .map((attempt) => `<li>${escapeHtml(attempt)}</li>`)
      .join("");

    const links = externalResult.links || {};
    const linkRows = [
      links.glassdoor
        ? `<a class="instahyre-salary-link" href="${escapeHtml(links.glassdoor)}" target="_blank" rel="noopener noreferrer">Search Glassdoor</a>`
        : "",
      links.ambitionbox
        ? `<a class="instahyre-salary-link" href="${escapeHtml(links.ambitionbox)}" target="_blank" rel="noopener noreferrer">Search AmbitionBox</a>`
        : "",
      links.leetcode
        ? `<a class="instahyre-salary-link" href="${escapeHtml(links.leetcode)}" target="_blank" rel="noopener noreferrer">Search LeetCode</a>`
        : "",
    ]
      .filter(Boolean)
      .join("");

    return `
      <div class="instahyre-salary-section">
        <p class="instahyre-salary-section-title">Market salary lookup</p>
        <p class="instahyre-salary-empty">No reliable salary range found automatically for this company and role.</p>
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
    const companyName = payload.companyName || "Company";
    const jobTitle = payload.jobTitle || "Role";

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

    panel.innerHTML = `
      <button type="button" class="instahyre-salary-close" aria-label="Close">×</button>
      <div class="instahyre-salary-header">
        <p class="instahyre-salary-kicker">Instahyre Salary Insight</p>
        <h3>${escapeHtml(companyName)} · ${escapeHtml(jobTitle)}</h3>
        ${metaParts.length ? `<p class="instahyre-salary-meta">${escapeHtml(metaParts.join(" · "))}</p>` : ""}
      </div>
      <div class="instahyre-salary-body">
        ${renderExternalSection(externalResult, loadingExternal)}
        ${
          salaryHtml
            ? `<div class="instahyre-salary-section"><p class="instahyre-salary-section-title">Instahyre API fields</p>${salaryHtml}</div>`
            : ""
        }
        ${instahyreRating}
        ${benefits}
      </div>
    `;

    panel.querySelector(".instahyre-salary-close").addEventListener("click", () => {
      panel.remove();
    });
  }

  async function fetchExternalSalary(payload) {
    const requestId = ++latestRequestId;

    renderPanel(payload, null, true);

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
      renderPanel(payload, { found: false, attempts: [error.message] }, false);
    }
  }

  injectPageScript();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data?.type !== "INSTAHYRE_SALARY_DATA") return;
    fetchExternalSalary(event.data.payload);
  });
})();
