/**
 * AutoApply — DOM Scraper
 * Extracts form fields and job description from the current page.
 */

const AutoApplyScraper = (() => {
  /**
   * Scrape all form fields and job description from the current page.
   * @returns {{ fields: Array, job_description: string }}
   */
  function scrapeFormFields() {
    const fields = [];
    const seen = new Set();

    // Find all interactive form elements
    const selectors = [
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="password"])',
      'select',
      'textarea',
      '[contenteditable="true"]',
    ];

    const elements = document.querySelectorAll(selectors.join(', '));

    elements.forEach((el) => {
      if (el.closest('.autoapply-overlay')) return; // Skip our own overlay

      // A descendant of a hidden container keeps its own computed display, so
      // visibility is judged with the shared box-based predicate: it is empty
      // when any ancestor is hidden, which is how a multi-step form hides the
      // steps the user has not reached yet.
      if (el.type === 'file') {
        // A styled upload widget hides the native input itself, and that input
        // is the only thing the resume can be attached to, so it is still
        // scraped — unless the container around it is not rendered either.
        if (insideHiddenContainer(el)) return;
      } else if (!AutoApplyFiller.isRenderedControl(el)) {
        return;
      }

      // One field per radio group. Radios in a group are a single question with
      // the same options, and per-member fields let the backend emit one check
      // instruction per member — the filler can only honour one of them.
      if (el.type === 'radio' && el.name) {
        const group = extractRadioGroup(el);
        if (group) {
          if (seen.has(group.id)) return;
          seen.add(group.id);
          fields.push(group);
          return;
        }
        // A lone radio, or a group this scraper cannot describe, still gets
        // the per-element treatment below.
      }

      const fieldData = extractFieldData(el);
      if (!fieldData) return;

      // Deduplicate by ID
      const key = fieldData.id || fieldData.name || fieldData.label || Math.random().toString();
      if (seen.has(key)) return;
      seen.add(key);

      fields.push(fieldData);
    });

    const jobDescription = extractJobDescription();

    const result = { fields, job_description: jobDescription };
    window.__autoapply_scraper = result;
    return result;
  }

  /**
   * Extract structured data from a single form element.
   * @param {HTMLElement} el - The form element
   * @returns {Object|null} Field data or null if should be skipped
   */
  function extractFieldData(el) {
    const tagName = el.tagName.toLowerCase();

    // Generate or use existing ID
    let fieldId = el.id || el.getAttribute('data-autoapply-id');
    if (!fieldId) {
      fieldId = AutoApplyUtils.generateId('field');
      el.setAttribute('data-autoapply-id', fieldId);
    }

    const label = AutoApplyFiller.findLabel(el);
    const type = getFieldType(el);
    if (isSensitiveNonApplicationField(el, label, type)) return null;

    const field = {
      id: fieldId,
      type: type,
      label: label,
      name: el.name || null,
      placeholder: el.placeholder || null,
      required: el.required || el.getAttribute('aria-required') === 'true',
      value: el.value || '',
      options: [],
      accept: null,
      max_length: el.maxLength > 0 ? el.maxLength : null,
      aria_label: el.getAttribute('aria-label') || null,
      group_name: null,
    };

    // Handle select elements — extract options
    if (tagName === 'select') {
      field.options = Array.from(el.options)
        .filter((opt) => opt.value && opt.value !== '')
        .map((opt) => opt.textContent.trim());
    }

    // Radios and checkboxes: options come from the whole group so the backend
    // can normalise the requested value to the page's own option text. Grouped
    // radios are consumed by extractRadioGroup() before they reach this
    // function; this branch covers lone radios and every checkbox.
    if (type === 'radio' || type === 'checkbox') {
      field.group_name = el.name;
      if (el.name) {
        field.options = Array.from(document.getElementsByName(el.name))
          .map((input) => optionText(input))
          .filter(Boolean);
      }
    }

    // Handle file inputs
    if (type === 'file') {
      field.accept = el.accept || null;
    }

    // Handle contenteditable
    if (el.hasAttribute('contenteditable')) {
      field.type = 'textarea';
      field.value = el.textContent.trim();
    }

    return field;
  }

  /** Never collect authentication, payment, or government-ID inputs. */
  function isSensitiveNonApplicationField(el, label, type) {
    if (type === 'password') return true;

    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    const blockedAutocomplete = [
      'current-password', 'new-password', 'one-time-code',
      'cc-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year',
      'cc-csc', 'cc-type', 'transaction-amount', 'transaction-currency'
    ];
    if (blockedAutocomplete.some(token => autocomplete.split(/\s+/).includes(token))) return true;

    const identity = [
      el.id, el.name, label, el.placeholder,
      el.getAttribute('aria-label')
    ].filter(Boolean).join(' ').toLowerCase();
    return /\b(password|passcode|one[- ]?time (?:code|password)|otp|credit card|card number|cvv|cvc|social security|ssn|bank account|routing number)\b/.test(identity);
  }

  /**
   * Determine the type of a form element.
   * @param {HTMLElement} el
   * @returns {string} Field type
   */
  function getFieldType(el) {
    const tagName = el.tagName.toLowerCase();
    if (tagName === 'select') return 'select';
    if (tagName === 'textarea') return 'textarea';
    if (el.hasAttribute('contenteditable')) return 'textarea';
    return el.type || 'text';
  }

  /**
   * Extract one field for an entire radio group.
   *
   * Radios in a group are one question with one set of options — the shape the
   * backend models (`FormField.type == "radio"` with `options`). Emitting one
   * field per member makes the backend produce one check instruction per
   * member, and radio inputs are mutually exclusive, so only the last of those
   * instructions survives.
   *
   * @param {HTMLElement} el - The first rendered member of the group
   * @returns {Object|null} Field data for the whole group
   */
  function extractRadioGroup(el) {
    const members = Array.from(document.getElementsByName(el.name))
      .filter((input) => (input.type || '').toLowerCase() === 'radio');
    if (members.length < 2) return null;

    const label = radioGroupLabel(members, el);
    if (isSensitiveNonApplicationField(el, label, 'radio')) return null;

    const options = [];
    members.forEach((member) => {
      const option = optionText(member);
      if (option && !options.includes(option)) options.push(option);
    });
    if (!options.length) return null;

    let groupId = members
      .map((member) => member.getAttribute('data-autoapply-id'))
      .find(Boolean);
    if (!groupId) groupId = AutoApplyUtils.generateId('radiogroup');
    // Every member shares the group id so the filler can resolve the group.
    members.forEach((member) => member.setAttribute('data-autoapply-id', groupId));

    const checked = members.find((member) => member.checked) || null;

    return {
      id: groupId,
      type: 'radio',
      label: label,
      name: el.name,
      placeholder: null,
      required: members.some((member) => member.required || member.getAttribute('aria-required') === 'true'),
      value: checked ? optionText(checked) : '',
      options: options,
      accept: null,
      max_length: null,
      aria_label: null,
      group_name: el.name,
    };
  }

  /**
   * True when the container around an element is not rendered either.
   * Keeps the file-input exemption (ext-6) from scraping an upload widget that
   * belongs to a later, hidden step: `display:none` above the element empties
   * every descendant's box list, and a `display:contents` wrapper is climbed
   * through because it never generates a box of its own.
   * @param {HTMLElement} el
   * @returns {boolean}
   */
  function insideHiddenContainer(el) {
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      if (typeof node.getClientRects !== 'function' || node.getClientRects().length > 0) return false;
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      node = node.parentElement;
    }
    return false;
  }

  /** Option text for one radio/checkbox member: its label, else its value. */
  function optionText(member) {
    return AutoApplyFiller.findLabel(member) || member.value || '';
  }

  /**
   * The question a radio group answers. Each member's own label is its option
   * ("Yes"), so a fieldset legend or a group-level label is preferred.
   * @param {Array<HTMLElement>} members
   * @param {HTMLElement} el - The member being scraped
   * @returns {string|null}
   */
  function radioGroupLabel(members, el) {
    const container = el.closest('fieldset, [role="radiogroup"], [role="group"]');
    if (container) {
      const legend = container.querySelector('legend');
      if (legend) {
        const text = cleanGroupLabel(legend.textContent);
        if (text) return text;
      }
      const labelledBy = container.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labelEl = document.getElementById(labelledBy);
        if (labelEl) {
          const text = cleanGroupLabel(labelEl.textContent);
          if (text) return text;
        }
      }
      const ariaLabel = container.getAttribute('aria-label');
      if (ariaLabel) {
        const text = cleanGroupLabel(ariaLabel);
        if (text) return text;
      }
    }

    // Climb the ancestors looking for a label that describes the group rather
    // than one of its members.
    let ancestor = el.parentElement;
    for (let depth = 0; ancestor && depth < 3; depth++, ancestor = ancestor.parentElement) {
      const candidates = ancestor.querySelectorAll('label, .label, .field-label, .form-label, [class*="label"]');
      for (const candidate of candidates) {
        if (members.some((member) => candidate.contains(member))) continue;
        const text = cleanGroupLabel(candidate.textContent);
        if (text) return text;
      }
    }

    const memberLabel = AutoApplyFiller.findLabel(members[0]);
    if (memberLabel) return memberLabel;
    return el.name ? cleanGroupLabel(el.name.replace(/[_-]/g, ' ')) : null;
  }

  /** Collapse a group label into the same shape findLabel() produces. */
  function cleanGroupLabel(text) {
    return String(text)
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanDescriptionElement(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll('nav,header,footer,form,button,input,select,textarea,[role="navigation"],[data-automation-id*="progress"],[class*="progress"],[class*="breadcrumb"]').forEach((node) => node.remove());
    const noisyLine = /^(skip to main content|sign in|settings|candidate home|search for jobs|back to job posting|apply now|autofill with resume|step \d+ of \d+|completed step|save and continue)$/i;
    const lines = (clone.innerText || clone.textContent || '')
      .split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line.length > 1 && !noisyLine.test(line) && !/^\S+@\S+\.\S+$/.test(line));
    const deduped = lines.filter((line, index) => index === 0 || line !== lines[index - 1]);
    return deduped.join('\n').trim().slice(0, 6000);
  }

  /**
   * Extract the job description from the current page.
   * @returns {string} Job description text (max 3000 chars)
   */
  function extractJobDescription() {
    // Strategy 1: Platform-specific selectors
    const platform = AutoApplyUtils.detectPlatform(window.location.href);
    const platformSelectors = {
      workday: [
        '[data-automation-id="jobPostingDescription"]',
        '.css-cygeeu', // Workday JD container
        '.job-description',
      ],
      greenhouse: [
        '#content .body', '.section-wrapper',
        '#header .company-name + div',
      ],
      lever: [
        '.section-wrapper.page-full-width',
        '.posting-page .content',
      ],
      ashby: [
        '.ashby-job-posting-description',
        '[class*="jobDescription"]',
      ],
      linkedin: [
        '.jobs-description__content',
        '.jobs-description',
        '.description__text',
        '.job-details-jobs-unified-top-card__job-insight',
      ],
      indeed: [
        '#jobDescriptionText',
        '.jobsearch-JobComponent-description',
        '.job-description',
      ],
      glassdoor: [
        '#JobDescriptionContainer',
        '.desc',
        '[class*="jobDescription"]',
      ],
      wellfound: [
        '.job-description',
        '.styles_description__',
        '[class*="description"]',
      ],
      darwinbox: [
        '.job-description',
        '.jd-section',
        '[class*="description"]',
      ],
      oracle: [
        '.job-description',
        '.requisition-description',
        '[data-bind*="description"]',
      ],
      naukri: [
        '.job-desc',
        '.jd-container',
        '[class*="job-description"]',
      ],
      instahyre: [
        '.job-description',
        '.profile-info',
      ],
      keka: [
        '.job-description',
        '[class*="job-details"]',
      ],
    };

    const selectors = platformSelectors[platform] || [];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) {
        return cleanDescriptionElement(el);
      }
    }

    // Strategy 2: Common generic selectors
    const genericSelectors = [
      '.job-description', '#job-description',
      '.jobDescription', '#jobDescription',
      '.job-details', '#job-details',
      '.posting-description', '.jd-info',
      '[class*="jobDescription"]', '[class*="job-description"]',
      '[data-testid="job-description"]',
    ];

    for (const sel of genericSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 100) {
        return cleanDescriptionElement(el);
      }
    }

    // Strategy 3: Look for sections with key headings
    const keyPhrases = [
      'Responsibilities', 'Requirements', 'Qualifications',
      'About the Role', 'What you\'ll do', 'Job Description',
      'About This Role', 'The Role', 'What We\'re Looking For',
    ];

    for (const phrase of keyPhrases) {
      const headings = document.querySelectorAll('h1, h2, h3, h4, strong, b');
      for (const heading of headings) {
        if (heading.textContent.toLowerCase().includes(phrase.toLowerCase())) {
          // Get the parent section
          const section = heading.closest('section, div, article');
          if (section && section.textContent.trim().length > 100) {
            return cleanDescriptionElement(section);
          }
        }
      }
    }

    // Strategy 4: Largest text block on the page (heuristic)
    const blocks = document.querySelectorAll('div, section, article');
    let bestBlock = null;
    let bestLen = 0;

    blocks.forEach((block) => {
      const text = block.textContent.trim();
      if (block.matches('nav,header,footer,form') || block.querySelectorAll('input,select,textarea').length > 4) return;
      // Look for blocks with substantial text and multiple paragraphs
      if (text.length > 200 && text.length < 10000) {
        const pCount = block.querySelectorAll('p, li').length;
        const score = text.length * (pCount > 3 ? 1.5 : 1);
        if (score > bestLen) {
          bestLen = score;
          bestBlock = block;
        }
      }
    });

    if (bestBlock) {
      return cleanDescriptionElement(bestBlock);
    }

    return '';
  }

  return { scrapeFormFields, extractJobDescription };
})();

if (typeof window !== 'undefined') {
  window.__autoapply_scraper_module = AutoApplyScraper;
}
