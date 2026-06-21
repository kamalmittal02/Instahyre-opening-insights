(function () {
  const SALARY_KEY_PATTERN =
    /salary|compensation|ctc|lpa|paycheck|pay_range|expected_pay|min_pay|max_pay/i;

  const WATCHED_URL_PATTERN =
    /\/api\/v1\/(?:employer_misc\/employer_profile|employer_public_jobs|candidate_opportunities|candidate_jobs|opportunity|jobs)/i;

  function deepCollectSalaryFields(value, path, results) {
    if (value == null) return;

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        deepCollectSalaryFields(item, `${path}[${index}]`, results);
      });
      return;
    }

    if (typeof value !== "object") return;

    for (const [key, nested] of Object.entries(value)) {
      const nextPath = path ? `${path}.${key}` : key;

      if (SALARY_KEY_PATTERN.test(key) && nested != null && nested !== "") {
        results.push({ path: nextPath, key, value: nested });
      }

      if (nested && typeof nested === "object") {
        deepCollectSalaryFields(nested, nextPath, results);
      }
    }
  }

  function extractPayload(url, json) {
    const salaryFields = [];
    deepCollectSalaryFields(json, "", salaryFields);

    const jobIdMatch = url.match(/jobId=(\d+)/);
    const employerMatch = url.match(/employer_profile\/(?:anon_employer|employer)\/(\d+)/);

    let job = null;
    if (Array.isArray(json.jobs) && json.jobs.length) {
      const requestedJobId = jobIdMatch ? Number(jobIdMatch[1]) : null;
      job =
        json.jobs.find((item) => item.id === requestedJobId) ||
        json.jobs[0];
    } else if (json.id && json.title) {
      job = json;
    }

    return {
      sourceUrl: url,
      companyName: json.company_name || job?.hiring_company_name || null,
      jobTitle: job?.title || job?.candidate_title || null,
      jobId: job?.id || (jobIdMatch ? Number(jobIdMatch[1]) : null),
      employerId: employerMatch ? Number(employerMatch[1]) : null,
      experience:
        job?.workex_min != null && job?.workex_max != null
          ? `${job.workex_min} - ${job.workex_max} years`
          : null,
      locations: job?.locations || json.location || null,
      benefits: json.benefits || null,
      glassdoor: json.glassdoor_data || null,
      salaryFields,
      rawJob: job,
    };
  }

  function publishPayload(payload) {
    window.postMessage(
      {
        type: "INSTAHYRE_SALARY_DATA",
        payload,
      },
      "*"
    );
  }

  async function inspectResponse(url, responsePromise) {
    if (!WATCHED_URL_PATTERN.test(url)) return responsePromise;

    try {
      const response = await responsePromise;
      const clone = response.clone();

      clone
        .json()
        .then((json) => publishPayload(extractPayload(url, json)))
        .catch(() => {});

      return response;
    } catch (error) {
      return responsePromise;
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const request = args[0];
    const url =
      typeof request === "string"
        ? request
        : request instanceof Request
          ? request.url
          : String(request);

    return inspectResponse(url, originalFetch.apply(this, args));
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__instahyreUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      const url = this.__instahyreUrl;
      if (!url || !WATCHED_URL_PATTERN.test(url)) return;

      try {
        const json = JSON.parse(this.responseText);
        publishPayload(extractPayload(url, json));
      } catch (error) {
        // Ignore non-JSON responses.
      }
    });

    return originalSend.apply(this, args);
  };
})();
