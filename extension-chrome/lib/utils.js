/**
 * AutoApply — Shared utility functions.
 * Available to all content scripts and background script.
 */

const AutoApplyUtils = (() => {
  const API_BASE_STORAGE_KEY = 'autoapplyApiBase';
  const DEFAULT_API_BASE = 'http://127.0.0.1:8000';

  /**
   * Normalize a user-supplied backend address. The backend is a local service,
   * so only loopback http URLs are accepted.
   * @param {string} value - Candidate base URL
   * @returns {string|null} Normalized base without a trailing slash, or null
   */
  function normalizeApiBase(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().replace(/\/+$/, '');
    if (!trimmed) return null;
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch (_) {
      return null;
    }
    if (parsed.protocol !== 'http:') return null;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return null;
    return trimmed;
  }

  /**
   * Resolve the backend base URL from extension storage.
   * @returns {Promise<string>} Base URL without a trailing slash
   */
  async function getApiBase() {
    try {
      if (typeof browser !== 'undefined' && browser.storage && browser.storage.local) {
        const stored = await browser.storage.local.get(API_BASE_STORAGE_KEY);
        const normalized = normalizeApiBase(stored ? stored[API_BASE_STORAGE_KEY] : null);
        if (normalized) return normalized;
      }
    } catch (error) {
      console.warn('[AutoApply] Could not read the stored backend address:', error);
    }
    return DEFAULT_API_BASE;
  }

  /**
   * Persist the backend base URL for every extension context.
   * @param {string} base - Loopback http URL, e.g. 'http://127.0.0.1:8123'
   * @returns {Promise<string>} The normalized value that was stored
   */
  async function setApiBase(base) {
    const normalized = normalizeApiBase(base);
    if (!normalized) throw new Error(`Enter the AutoApply address on this computer, for example ${DEFAULT_API_BASE}.`);
    await browser.storage.local.set({ [API_BASE_STORAGE_KEY]: normalized });
    return normalized;
  }

  /**
   * Build the Error thrown by apiCall().
   *
   * The sentence a user reads is plain language; the HTTP status and the
   * backend's own detail travel as properties so callers can classify a
   * failure (missing profile, provider unavailable, rate limit) without
   * printing internals into the UI.
   *
   * @param {number|undefined} status - HTTP status, when one was received
   * @param {string|undefined} detail - Backend-provided detail, already plain
   * @returns {Error} Error with `status` and `detail` properties
   */
  function buildRequestError(status, detail) {
    const fallback = 'AutoApply could not complete that request. Try again in a moment.';
    const message = typeof status === 'number' && status >= 500
      ? fallback
      : (detail || fallback);
    const error = new Error(message);
    if (typeof status === 'number') error.status = status;
    if (detail) error.detail = detail;
    return error;
  }

  /** Pull the backend's own message out of a response body, if it has one. */
  async function responseDetail(response) {
    const text = await response.text().catch(() => '');
    try {
      const parsed = JSON.parse(text);
      return parsed && (parsed.detail || parsed.ai_error) ? String(parsed.detail || parsed.ai_error) : text;
    } catch (_) {
      return text;
    }
  }

  /**
   * Make an API call to the backend.
   * @param {string} endpoint - API endpoint (e.g. '/api/autofill')
   * @param {string} method - HTTP method
   * @param {*} body - Request body (will be JSON.stringify'd)
   * @returns {Promise<*>} Parsed JSON response
   */
  async function apiCall(endpoint, method = 'GET', body = null) {
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
      const response = await browser.runtime.sendMessage({
        type: 'API_CALL_PROXY',
        endpoint,
        method,
        body
      });
      if (response && response.status === 'success') {
        return response.data;
      }
      throw buildRequestError(
        response ? response.httpStatus : undefined,
        (response && (response.detail || response.error)) || undefined
      );
    }

    // Fallback if not in extension context
    const base = await getApiBase();
    const url = `${base}${endpoint}`;
    const options = {
      method,
      signal: AbortSignal.timeout(30000)
    };
    if (method !== 'GET') {
      options.headers = { 'Content-Type': 'application/json' };
      if (body) {
        options.body = JSON.stringify(body);
      }
    }

    const res = await fetch(url, options);
    if (!res.ok) {
      throw buildRequestError(res.status, await responseDetail(res));
    }
    return res.json();
  }

  /**
   * Call an optional workspace endpoint. Workspace data is local user state
   * (opportunities, packets, resume versions, teaches, and receipts), so a
   * workspace failure must never stop ordinary autofill.
   */
  async function workspaceCall(endpoint, method = 'GET', body = null) {
    const normalized = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return apiCall(`/api/workspace${normalized}`, method, body);
  }

  /**
   * Generate a simple unique ID.
   * @param {string} prefix - Optional prefix
   * @returns {string} Unique ID
   */
  function generateId(prefix = 'aa') {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  /**
   * Words that never identify an employer. Membership is checked after
   * punctuation is stripped and text lowercased, so 'job-boards' and
   * 'Job Boards' both normalise to 'jobboards'. Platform brand names are
   * included because job boards often put their own name in og:site_name.
   */
  const GENERIC_COMPANY_WORDS = new Set([
    'jobs', 'job', 'jobboard', 'jobboards', 'boards', 'board',
    'careers', 'career', 'apply', 'www', 'hiring', 'hire',
    'recruiting', 'recruitment', 'talent', 'myworkdayjobs', 'work',
    'greenhouse', 'lever', 'ashby', 'ashbyhq', 'smartrecruiters', 'workday',
    'icims', 'taleo', 'oraclecloud', 'workable', 'personio', 'recruitee',
    'bamboohr', 'jobvite', 'breezy', 'teamtailor', 'pinpoint',
  ]);

  /** Values that are an application instruction rather than a role name. */
  const ROLE_BOILERPLATE = new Set([
    'apply', 'applynow', 'jobapplication', 'jobapplicationform',
    'applyforthisjob', 'careers', 'career', 'jobs', 'job',
    'openpositions', 'positions', 'unknown',
  ]);

  /** Separators job boards use between role, location, and employer. */
  const ROLE_SEPARATOR = /\s+[-–—|·•@]\s+|\s+at\s+/i;

  function parseUrl(url) {
    try {
      return new URL(url);
    } catch (_) {
      return null;
    }
  }

  function pathSegments(parsed) {
    return parsed.pathname
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch (_) {
          return segment;
        }
      });
  }

  function firstPathSegment(parsed, skip = []) {
    const skipped = new Set(skip.map((name) => name.toLowerCase()));
    for (const segment of pathSegments(parsed)) {
      if (!skipped.has(segment.toLowerCase())) return segment;
    }
    return null;
  }

  function subdomainOf(hostname) {
    const labels = hostname.toLowerCase().split('.');
    return labels.length > 2 ? labels[0] : '';
  }

  function isGenericCompany(value) {
    const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return !normalized || GENERIC_COMPANY_WORDS.has(normalized);
  }

  function sameName(left, right) {
    const normalize = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const normalized = normalize(left);
    return Boolean(normalized) && normalized === normalize(right);
  }

  /**
   * Split a slug into words and title-case it: 'acme-holdings' -> 'Acme
   * Holdings', 'RaisingCanes' -> 'Raising Canes'. Short all-caps acronyms are
   * kept verbatim ('GDIT'). No brand normalisation beyond this.
   * @param {string} slug - Raw path segment or subdomain label
   * @returns {string} Human-readable name, or '' when the slug is empty
   */
  function humanizeSlug(slug) {
    if (typeof slug !== 'string') return '';
    let value = slug.trim();
    if (!value) return '';
    try {
      value = decodeURIComponent(value);
    } catch (_) {
      // Keep the raw value when it is not valid percent-encoding.
    }
    value = value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    const words = value.split(/[\s\-_.]+/).filter(Boolean);
    if (!words.length) return '';
    return words
      .map((word) => {
        const isAcronym =
          word.length > 1 && word.length <= 5 && word === word.toUpperCase() && /[A-Za-z]/.test(word);
        return isAcronym ? word : word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }

  /**
   * How each job board names the employer and marks its role heading. Ordered:
   * the first hostname match wins. `match` receives a lowercased hostname;
   * `company` receives the parsed URL and returns a raw slug, which
   * extractCompany humanizes and rejects when generic. `nextControlSelectors`
   * are next/continue controls only — they must never match the final submit
   * control, which AutoApply never clicks.
   */
  const SITE_ADAPTERS = [
    {
      id: 'workday',
      match: (hostname) => hostname.includes('myworkdayjobs.com') || hostname.includes('workday.com'),
      platform: 'workday',
      company: (parsed) => {
        const label = subdomainOf(parsed.hostname);
        return label && !/^wd\d+$/.test(label) ? label : null;
      },
      roleSelector: '[data-automation-id="jobPostingHeader"], h1',
      nextControlSelectors: [
        '[data-automation-id="bottom-navigation-next-button"]',
        '[data-automation-id="pageFooterNextButton"]',
      ],
    },
    {
      id: 'greenhouse',
      match: (hostname) => hostname.includes('greenhouse.io'),
      platform: 'greenhouse',
      company: (parsed) => {
        const first = pathSegments(parsed)[0];
        if (first && first !== 'embed') return first;
        return parsed.searchParams.get('for') || null;
      },
      roleSelector: '.app-title, h1',
      nextControlSelectors: [],
    },
    {
      id: 'lever',
      match: (hostname) => hostname.includes('lever.co'),
      platform: 'lever',
      company: (parsed) => firstPathSegment(parsed),
      roleSelector: '.posting-headline h2, h1',
      nextControlSelectors: [],
    },
    {
      id: 'ashby',
      match: (hostname) => hostname.includes('ashbyhq.com'),
      platform: 'ashby',
      company: (parsed) => firstPathSegment(parsed),
      roleSelector: 'h1',
      nextControlSelectors: [],
    },
    {
      id: 'smartrecruiters',
      match: (hostname) => hostname.includes('smartrecruiters.com'),
      platform: 'smartrecruiters',
      company: (parsed) => {
        const first = pathSegments(parsed)[0];
        if (!first || first === 'oneclick-ui' || first === 'oneclick') return null;
        return first;
      },
      roleSelector: 'h1.job-title, h1',
      nextControlSelectors: ['button[data-test="next-button"]'],
    },
    {
      id: 'icims',
      match: (hostname) => hostname.includes('icims.com'),
      platform: 'icims',
      company: (parsed) => {
        const label = subdomainOf(parsed.hostname);
        if (!label) return null;
        const prefixed = /^(?:us)?careers?[-.](.+)$/i.exec(label);
        if (prefixed) return prefixed[1];
        const suffixed = /^(.+?)[-.]careers?$/i.exec(label);
        if (suffixed) return suffixed[1];
        return label;
      },
      roleSelector: '.iCIMS_JobHeader h1, h1',
      nextControlSelectors: [
        'input[type="submit"][value*="Next" i]',
        'input[type="button"][value*="Next" i]',
        'a.iCIMS_NextButton',
      ],
    },
    {
      id: 'taleo',
      match: (hostname) => hostname.includes('taleo'),
      platform: 'taleo',
      company: (parsed) =>
        subdomainOf(parsed.hostname) || firstPathSegment(parsed, ['careersection', 'careers', 'jobs']),
      roleSelector: '.titlepage, h1',
      nextControlSelectors: ['input[type="button"][value*="Next" i]', '#nextButton'],
    },
    {
      id: 'oraclecloud',
      match: (hostname) => hostname.includes('oraclecloud.com'),
      platform: 'oracle',
      company: (parsed) => subdomainOf(parsed.hostname),
      roleSelector: 'h1, [data-automation-id="jobPostingHeader"]',
      nextControlSelectors: ['button[data-automation-id="nextButton"]'],
    },
    {
      id: 'workable',
      match: (hostname) => hostname.includes('workable.com'),
      platform: 'workable',
      company: (parsed) => {
        const first = pathSegments(parsed)[0];
        if (first && first !== 'j' && first !== 'p') return first;
        return subdomainOf(parsed.hostname) || null;
      },
      roleSelector: 'h1',
      nextControlSelectors: [],
    },
    {
      id: 'personio',
      match: (hostname) => hostname.includes('personio.'),
      platform: 'personio',
      company: (parsed) => subdomainOf(parsed.hostname),
      roleSelector: 'h1',
      nextControlSelectors: ['button[data-testid="next-button"]'],
    },
    {
      id: 'recruitee',
      match: (hostname) => hostname.includes('recruitee.com'),
      platform: 'recruitee',
      company: (parsed) => subdomainOf(parsed.hostname),
      roleSelector: 'h1',
      nextControlSelectors: [],
    },
    {
      id: 'bamboohr',
      match: (hostname) => hostname.includes('bamboohr.com'),
      platform: 'bamboohr',
      company: (parsed) => subdomainOf(parsed.hostname) || firstPathSegment(parsed, ['careers', 'jobs']),
      roleSelector: 'h1',
      nextControlSelectors: [],
    },
    {
      id: 'jobvite',
      match: (hostname) => hostname.includes('jobvite.com'),
      platform: 'jobvite',
      company: (parsed) => {
        const label = subdomainOf(parsed.hostname);
        if (label && !isGenericCompany(label)) return label;
        return firstPathSegment(parsed, ['careers', 'jobs', 'job', 'apply']);
      },
      roleSelector: 'h1',
      nextControlSelectors: [],
    },
    {
      id: 'breezy',
      match: (hostname) => hostname.includes('breezy.hr'),
      platform: 'breezy',
      company: (parsed) => subdomainOf(parsed.hostname),
      roleSelector: 'h1',
      nextControlSelectors: [],
    },
    {
      id: 'teamtailor',
      match: (hostname) => hostname.includes('teamtailor.com'),
      platform: 'teamtailor',
      company: (parsed) => subdomainOf(parsed.hostname),
      roleSelector: 'h1',
      nextControlSelectors: [],
    },
    {
      id: 'pinpoint',
      match: (hostname) => hostname.includes('pinpointhq.com'),
      platform: 'pinpoint',
      company: (parsed) => subdomainOf(parsed.hostname),
      roleSelector: 'h1',
      nextControlSelectors: [],
    },
  ];

  /**
   * Find the adapter for a URL.
   * @param {string} url - Page URL
   * @returns {object|null} The matching adapter, or null for an unknown host
   */
  function getSiteAdapter(url) {
    const parsed = parseUrl(url);
    if (!parsed) return null;
    const hostname = parsed.hostname.toLowerCase();
    return SITE_ADAPTERS.find((adapter) => adapter.match(hostname)) || null;
  }

  /**
   * Detect the ATS platform from a URL.
   * @param {string} url - The page URL
   * @returns {string} Platform name
   */
  function detectPlatform(url) {
    const adapter = getSiteAdapter(url);
    if (adapter && adapter.platform) return adapter.platform;

    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch (_) {
      return 'custom';
    }

    // Aggregators and boards without an adapter: the host names the platform.
    const boards = [
      ['linkedin.com', 'linkedin'],
      ['indeed.com', 'indeed'],
      ['glassdoor.com', 'glassdoor'],
      ['wellfound.com', 'wellfound'],
      ['angel.co', 'wellfound'],
      ['darwinbox.com', 'darwinbox'],
      ['naukri.com', 'naukri'],
      ['instahyre.com', 'instahyre'],
      ['keka.com', 'keka'],
    ];
    for (const [host, platform] of boards) {
      if (hostname.includes(host)) return platform;
    }

    return 'custom';
  }

  function currentDocument() {
    return typeof document !== 'undefined' ? document : null;
  }

  function structuredDataNodes(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const nodes = doc.querySelectorAll('script[type="application/ld+json"]');
    return nodes ? Array.from(nodes) : [];
  }

  function collectJobPostings(value, found) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((entry) => collectJobPostings(entry, found));
      return;
    }
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    if (types.some((type) => typeof type === 'string' && type.toLowerCase() === 'jobposting')) {
      found.push(value);
    }
    if (value['@graph']) collectJobPostings(value['@graph'], found);
  }

  /** First JobPosting object in the page's JSON-LD, or null. */
  function jobPosting(doc) {
    const found = [];
    for (const node of structuredDataNodes(doc)) {
      if (!node.textContent) continue;
      try {
        collectJobPostings(JSON.parse(node.textContent), found);
      } catch (_) {
        // A malformed ld+json block must not break company/role extraction.
      }
    }
    return found[0] || null;
  }

  function metaContent(doc, property) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const node = doc.querySelector(`meta[property="${property}"], meta[name="${property}"]`);
    const content = node && node.content;
    return typeof content === 'string' && content.trim() ? content.trim() : null;
  }

  function elementText(doc, selector) {
    if (!doc || !selector || typeof doc.querySelector !== 'function') return null;
    const node = doc.querySelector(selector);
    const text = node && node.textContent;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  }

  /** Employer named by the page's JSON-LD JobPosting, or null. */
  function structuredCompany(doc) {
    const posting = jobPosting(doc);
    if (!posting) return null;
    const organization = posting.hiringOrganization;
    const name = typeof organization === 'string' ? organization : organization && organization.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  }

  /** Role named by the page's JSON-LD JobPosting, or null. */
  function structuredRole(doc) {
    const posting = jobPosting(doc);
    const title = posting && posting.title;
    return typeof title === 'string' && title.trim() ? title.trim() : null;
  }

  /** Location already captured in JSON-LD, used to drop duplicate suffixes. */
  function structuredLocation(doc) {
    const posting = jobPosting(doc);
    const location = posting && posting.jobLocation;
    if (!location) return null;
    const first = Array.isArray(location) ? location[0] : location;
    if (!first) return null;
    if (typeof first === 'string') return first.trim() || null;
    if (typeof first.name === 'string' && first.name.trim()) return first.name.trim();
    const address = first.address;
    const city = address && (address.addressLocality || address.addressRegion);
    return typeof city === 'string' && city.trim() ? city.trim() : null;
  }

  /**
   * Read the employer from a page title such as 'Software Engineer - Acme' or
   * 'Acme | Careers'. Only a tail after a separator counts; a bare title is
   * the role, not the company.
   */
  function companyFromTitle(title) {
    if (typeof title !== 'string' || !title.trim()) return null;
    const segments = title
      .split(ROLE_SEPARATOR)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length < 2) return null;
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      const candidate = segments[index];
      if (candidate.length > 60) continue;
      if (!isGenericCompany(candidate)) return candidate;
    }
    return null;
  }

  /**
   * Resolve the employer: JSON-LD -> og:site_name -> adapter rule -> title
   * tail -> 'Unknown'. A generic host word is never a company.
   */
  function resolveCompany(url, title, doc) {
    const structured = structuredCompany(doc);
    if (structured && !isGenericCompany(structured)) return structured;

    const siteName = metaContent(doc, 'og:site_name');
    if (siteName && !isGenericCompany(siteName)) return siteName;

    const adapter = getSiteAdapter(url);
    if (adapter) {
      const parsed = parseUrl(url);
      const raw = parsed ? adapter.company(parsed, doc) : null;
      const humanized = humanizeSlug(raw);
      if (humanized && !isGenericCompany(humanized)) return humanized;
    }

    const fromTitle = companyFromTitle(title);
    if (fromTitle) return fromTitle;

    return 'Unknown';
  }

  /**
   * Extract company name from URL or page title.
   * @param {string} url - Page URL
   * @param {string} title - Page title
   * @returns {string} Best guess at company name, or 'Unknown'
   */
  function extractCompany(url, title) {
    return resolveCompany(url, title, currentDocument());
  }

  /** Drop a leading or trailing employer segment from a role string. */
  function stripCompany(value, company) {
    let segments = value
      .split(ROLE_SEPARATOR)
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (segments.length > 1 && coincidesWithCompany(segments[segments.length - 1], company)) {
      segments = segments.slice(0, -1);
    }
    if (segments.length > 1 && coincidesWithCompany(segments[0], company)) {
      segments = segments.slice(1);
    }
    return segments.join(' - ');
  }

  /**
   * True when a candidate is the employer rather than the role. Boards are
   * often named after the company with a numeric suffix ('Lever Demo 2' for
   * the slug 'leverdemo'), so a trailing number is ignored in the comparison.
   */
  function coincidesWithCompany(value, company) {
    if (!company || company === 'Unknown') return false;
    if (sameName(value, company)) return true;
    const withoutTrailingNumber = String(value).replace(/[\s\-–—_]+\d+$/, '');
    return withoutTrailingNumber !== value && sameName(withoutTrailingNumber, company);
  }

  /** Drop a trailing '(Location)' only when JSON-LD already carries it. */
  function stripDuplicateLocation(value, doc) {
    const location = structuredLocation(doc);
    if (!location) return value;
    const match = /^(.*?)\s*[([{]([^()[\]{}]+)[)\]}]\s*$/.exec(value);
    if (!match || !sameName(match[2], location)) return value;
    return match[1].trim();
  }

  function cleanRole(raw, { company, doc } = {}) {
    if (typeof raw !== 'string') return null;
    let value = raw.replace(/\s+/g, ' ').trim();
    if (!value) return null;

    // 'Job Application for X', 'Apply for X', 'Apply: X', ...
    value = value
      .replace(/^(?:job application for|apply(?: (?:for|to))?|opening for|position|role)\s*[:\-–—]?\s*/i, '')
      .replace(/^[\s\-–—|·•:]+/, '')
      .trim();
    // Tracking suffixes that are not part of the role.
    value = value.replace(/\s*[|\-–—]\s*(?:apply(?: now)?|job application)\s*$/i, '').trim();

    if (company && company !== 'Unknown') value = stripCompany(value, company);
    value = stripDuplicateLocation(value, doc);
    value = value.replace(/\s+/g, ' ').trim();

    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!normalized || ROLE_BOILERPLATE.has(normalized)) return null;
    if (company && company !== 'Unknown' && coincidesWithCompany(value, company)) return null;
    return value;
  }

  /**
   * Extract the role: JSON-LD title -> og:title -> adapter role selector ->
   * cleaned document title. Board names and application instructions are not
   * roles, so they resolve to 'Unknown'.
   * @param {string} url - Page URL
   * @param {string} title - Page title
   * @param {Document} [doc] - Document to read; defaults to the global one
   * @returns {string} Best guess at role name, or 'Unknown'
   */
  function extractRole(url, title, doc) {
    const page = doc === undefined ? currentDocument() : doc;
    const company = resolveCompany(url, title, page);
    const adapter = getSiteAdapter(url);
    const candidates = [
      structuredRole(page),
      metaContent(page, 'og:title'),
      elementText(page, adapter ? adapter.roleSelector : 'h1'),
      typeof title === 'string' ? title : '',
    ];
    for (const candidate of candidates) {
      const role = cleanRole(candidate, { company, doc: page });
      if (role) return role;
    }
    return 'Unknown';
  }

  /**
   * Escape HTML to prevent XSS injections from untrusted text.
   * @param {string} str - Raw string
   * @returns {string} HTML-safe string
   */
  function escapeHTML(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  return {
    getApiBase,
    setApiBase,
    apiCall,
    workspaceCall,
    generateId,
    detectPlatform,
    extractCompany,
    extractRole,
    humanizeSlug,
    getSiteAdapter,
    SITE_ADAPTERS,
    escapeHTML,
  };
})();

// Make available globally for other content scripts
if (typeof window !== 'undefined') {
  window.__autoapply_utils = AutoApplyUtils;
}
