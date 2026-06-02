/**
 * AutoApply — Shared utility functions.
 * Available to all content scripts and background script.
 */

const AutoApplyUtils = (() => {
  const API_BASE = 'http://localhost:8000';

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
      } else {
        throw new Error(response ? response.error : 'Unknown background proxy error');
      }
    }

    // Fallback if not in extension context
    const url = `${API_BASE}${endpoint}`;
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
      const errorText = await res.text();
      throw new Error(`API error ${res.status}: ${errorText}`);
    }
    return res.json();
  }

  /**
   * Debounce a function.
   * @param {Function} fn - Function to debounce
   * @param {number} ms - Delay in milliseconds
   * @returns {Function} Debounced function
   */
  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
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
   * Detect the ATS platform from a URL.
   * @param {string} url - The page URL
   * @returns {string} Platform name
   */
  function detectPlatform(url) {
    let hostname;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return 'custom';
    }

    if (hostname.includes('myworkdayjobs.com') || hostname.includes('workday.com')) {
      return 'workday';
    }
    if (hostname.includes('greenhouse.io') || hostname.includes('boards.greenhouse.io')) {
      return 'greenhouse';
    }
    if (hostname.includes('lever.co') || hostname.includes('jobs.lever.co')) {
      return 'lever';
    }
    if (hostname.includes('ashbyhq.com')) {
      return 'ashby';
    }
    if (hostname.includes('icims.com')) {
      return 'icims';
    }
    if (hostname.includes('smartrecruiters.com')) {
      return 'smartrecruiters';
    }
    if (hostname.includes('taleo')) {
      return 'taleo';
    }
    if (hostname.includes('bamboohr.com')) {
      return 'bamboohr';
    }
    if (hostname.includes('linkedin.com')) {
      return 'linkedin';
    }
    if (hostname.includes('indeed.com')) {
      return 'indeed';
    }
    if (hostname.includes('glassdoor.com')) {
      return 'glassdoor';
    }
    if (hostname.includes('wellfound.com') || hostname.includes('angel.co')) {
      return 'wellfound';
    }
    if (hostname.includes('darwinbox.com')) {
      return 'darwinbox';
    }
    if (hostname.includes('oraclecloud.com')) {
      return 'oracle';
    }
    if (hostname.includes('naukri.com')) {
      return 'naukri';
    }
    if (hostname.includes('instahyre.com')) {
      return 'instahyre';
    }
    if (hostname.includes('keka.com')) {
      return 'keka';
    }

    return 'custom';
  }

  /**
   * Extract company name from URL or page title.
   * @param {string} url - Page URL
   * @param {string} title - Page title
   * @returns {string} Best guess at company name
   */
  function extractCompany(url, title) {
    const hostname = new URL(url).hostname;

    // Check known ATS patterns where company is in subdomain
    const atsPatterns = [
      'myworkdayjobs.com', 'greenhouse.io', 'lever.co', 'ashbyhq.com',
      'icims.com', 'smartrecruiters.com',
    ];

    for (const ats of atsPatterns) {
      if (hostname.includes(ats)) {
        const parts = hostname.split('.');
        if (parts.length > 2) {
          return parts[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        }
      }
    }

    // Try from title
    if (title.includes(' - ')) return title.split(' - ').pop().trim();
    if (title.includes(' at ')) return title.split(' at ').pop().trim();
    if (title.includes(' | ')) return title.split(' | ').pop().trim();

    // Fallback to domain
    return hostname.split('.')[0].replace(/\b\w/g, c => c.toUpperCase());
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

  return { API_BASE, apiCall, debounce, generateId, detectPlatform, extractCompany, escapeHTML };
})();

// Make available globally for other content scripts
if (typeof window !== 'undefined') {
  window.__autoapply_utils = AutoApplyUtils;
}
