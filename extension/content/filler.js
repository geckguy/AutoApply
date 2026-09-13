/**
 * AutoApply — Form Filler
 * Programmatically fills form fields and handles navigation.
 */

const AutoApplyFiller = (() => {
  // Navigation is intentionally more restrictive than the labels that a site may
  // use. The extension must never turn "Fill & Next" into a submission action.
  const NEXT_BUTTON_TEXTS = [
    'next', 'continue', 'save & continue', 'save and continue',
    'proceed', 'save & next', 'save and next', 'forward',
  ];
  const SUBMIT_LIKE_TEXT = [
    'submit', 'apply', 'finish', 'complete', 'confirm', 'review', 'send',
  ];

  // Class the injected stylesheet turns into the pulsing upload cue. The page's
  // own inline styles are never written, and nothing else marks the element.
  const UPLOAD_HIGHLIGHT_CLASS = 'autoapply-upload-highlight';

  let cachedBodyText = null;

  /**
   * Rendered page text, used for step/progress detection.
   * `innerText` is deliberate: `textContent` also returns hidden nodes, so a
   * hidden "Step 1 of 3" template would flip the last-page verdict. Serialising
   * the document is expensive, so the result is cached until the page is
   * navigated (a detected change or our own Next click) or a caller forces it.
   * @param {boolean} [force] - Re-read the document now
   * @returns {string} Current page text
   */
  function bodyText(force = false) {
    if (force || cachedBodyText === null) {
      cachedBodyText = (document.body && document.body.innerText) || '';
    }
    return cachedBodyText;
  }

  function controlText(el) {
    return [
      el.textContent,
      el.value,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('name'),
      el.getAttribute('id'),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .trim();
  }

  /** Return true for a control that could submit or finalize an application. */
  function isSubmitLikeControl(el) {
    const declaredType = (el.getAttribute('type') || '').toLowerCase();
    if (declaredType === 'submit' || declaredType === 'image') {
      return true;
    }
    // A <button> with no type attribute defaults to "submit", but only when it
    // has an owner form: elsewhere (cookie banner, menu, chat widget) it cannot
    // submit anything, and treating it as such marks every page of a multi-step
    // form as the final one.
    if (!declaredType && String(el.tagName || '').toUpperCase() === 'BUTTON' && el.form) {
      return true;
    }
    if (el.hasAttribute('formaction') || el.hasAttribute('formmethod')) {
      return true;
    }
    const text = controlText(el);
    return SUBMIT_LIKE_TEXT.some((term) => text.includes(term));
  }

  /**
   * Return true when a control is actually rendered. `offsetParent` is null for
   * a fixed-position element (and for anything inside a fixed wrapper), so it
   * cannot be used to judge visibility — it hides floating Next/Continue CTAs.
   * The box list is also empty for descendants of a hidden container, which is
   * how a multi-step form hides its later steps; the scraper shares this
   * predicate so fields from those steps never reach the panel.
   */
  function isRenderedControl(el) {
    if (!el || el.hidden) return false;
    if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
      return false;
    }
    return true;
  }

  /** Return true only for an explicitly safe, non-submitting navigation control. */
  function isSafeNextControl(el) {
    if (!el || !isRenderedControl(el) || el.disabled) return false;
    if (el.closest('.autoapply-overlay')) return false;
    if (isSubmitLikeControl(el)) return false;

    const text = controlText(el);
    return NEXT_BUTTON_TEXTS.some((target) => text.includes(target));
  }

  function navigationControls() {
    return [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('input[type="button"]'),
      ...document.querySelectorAll('a[role="button"]'),
      ...document.querySelectorAll('[role="button"]'),
    ];
  }

  /**
   * Fill a single form field based on an instruction.
   * Dispatches proper events for React/Angular/Vue framework compatibility.
   * The outcome carries `reformatted: true` (and the value that landed) when
   * the page kept our answer but rewrote its formatting, so the panel can say
   * so instead of silently accepting it.
   * @param {Object} instruction - Fill instruction from backend
   * @returns {Promise<{ ok: boolean, field_id: string, action: string, reason: string, reformatted: boolean, landed_value?: string }>}
   */
  async function fillField(instruction, options = {}) {
    const { field_id, action, value } = instruction;
    if (action === 'skip') {
      return { ok: false, field_id, action, reason: 'Skipped by the mapping.', reformatted: false };
    }
    if (value === undefined || value === null) {
      return { ok: false, field_id, action, reason: 'No value was supplied for this field.', reformatted: false };
    }

    // Find the element by ID or data attribute. A radio group shares one
    // data-autoapply-id across its members, so this resolves to a member and
    // fillCheckbox() reaches the rest of the group through its name.
    let el = document.getElementById(field_id);
    if (!el) {
      el = document.querySelector(`[data-autoapply-id="${CSS.escape(field_id)}"]`);
    }
    if (!el) {
      console.warn(`[AutoApply] Field not found: ${field_id}`);
      return { ok: false, field_id, action, reason: 'The field is no longer present on this page.', reformatted: false };
    }

    try {
      let ok = false;
      let reason = '';
      let reformattedValue = null;
      switch (action) {
        case 'fill':
          // A manual edit of a radio/checkbox row arrives as a plain value; it
          // still has to land as a selected choice, not as an input value.
          if (el.type === 'radio' || el.type === 'checkbox') {
            ok = fillCheckbox(el, value);
            reason = `Could not set the choice “${value}”.`;
          } else {
            const verdict = await fillTextInput(el, value);
            ok = verdict.ok;
            reason = verdict.reason || 'The page rejected the text value.';
            reformattedValue = verdict.reformatted ? verdict.landed_value : null;
          }
          break;

        case 'select':
          ok = await fillSelect(el, value);
          reason = `No matching option was available for “${value}”.`;
          break;

        case 'check':
          ok = fillCheckbox(el, value);
          reason = `Could not set the choice “${value}”.`;
          break;

        case 'upload':
          if (typeof options.uploadHandler === 'function') {
            const upload = await options.uploadHandler(el, instruction);
            ok = Boolean(upload && upload.ok);
            reason = upload && upload.reason ? upload.reason : 'The resume could not be attached automatically.';
          } else {
            highlightUploadField(el);
            reason = 'Choose a resume version to attach automatically, or select the file manually.';
          }
          break;

        default:
          console.warn(`[AutoApply] Unknown action: ${action}`);
          reason = `Unsupported fill action: ${action}.`;
      }
      const outcome = { ok, field_id, action, reason: ok ? '' : reason, reformatted: Boolean(reformattedValue) };
      if (reformattedValue) outcome.landed_value = reformattedValue;
      return outcome;
    } catch (err) {
      console.error(`[AutoApply] Error filling ${field_id}:`, err);
      return { ok: false, field_id, action, reason: err.message || 'The page prevented this field from being filled.', reformatted: false };
    }
  }

  /**
   * Convert the date formats the backend prompt emits into the only format a
   * native date input accepts (YYYY-MM-DD). Returns null when unrecognised.
   */
  function normaliseDateValue(value) {
    const text = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthIndex = (name) => MONTHS.indexOf(String(name).slice(0, 3).toLowerCase()) + 1;
    const iso = (year, month, day) => {
      const m = Number(month);
      const d = Number(day);
      if (!Number.isInteger(m) || m < 1 || m > 12) return null;
      if (!Number.isInteger(d) || d < 1 || d > 31) return null;
      return `${String(year).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    };

    let match = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/);
    if (match) {
      // The prompt emits MM/DD/YYYY; a first part above 12 can only be a day.
      const [, first, second, year] = match;
      return Number(first) > 12 ? iso(year, second, first) : iso(year, first, second);
    }
    match = text.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
    if (match) return iso(match[1], match[2], match[3]);
    match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
    if (match) return iso(match[3], monthIndex(match[2]), match[1]);
    match = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
    if (match) return iso(match[3], monthIndex(match[1]), match[2]);
    return null;
  }

  // How long a masked control gets to rewrite a value before we call its
  // output final. A formatter that runs synchronously on `input` has already
  // run when we read back, but React-controlled masks and intl-tel-input-style
  // widgets reformat on the next tick or on blur, so one delayed re-read is
  // the cheapest honest answer. Ordinary fields never pay for it.
  const MASK_SETTLE_MS = 120;

  const PHONE_VALUE = /^[+()\-.\s\d]+$/;
  const PHONE_HINT = /phone|mobile|telephone|(^|[^a-z])tel([^a-z]|$)/i;

  /** True for a value that is a formatted phone number, i.e. may meet a mask. */
  function looksLikePhoneValue(value) {
    const text = String(value);
    return PHONE_VALUE.test(text) && text.replace(/\D/g, '').length >= 7;
  }

  /**
   * True when the control carries a phone mask of its own — the fields whose
   * formatter can rewrite what we set: `type=tel`/`type=number`, a phone hint
   * in the control's own attributes, a `pattern` written only from digit
   * classes and phone separators, or a `maxlength` sized for a formatted
   * number. Callers pair this with looksLikePhoneValue(), so a plain text
   * field holding a non-phone value is never treated as masked.
   */
  function phoneMaskControl(el) {
    const type = (el.type || '').toLowerCase();
    if (type === 'tel' || type === 'number') return true;

    const hint = [el.id, el.name, el.placeholder, el.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');
    if (PHONE_HINT.test(hint)) return true;

    const pattern = el.getAttribute('pattern') || '';
    if (pattern && /^[\d\\^$()\[\]{}?*+|.\-\s]+$/.test(pattern) && /(\\d|\[0-9\])/.test(pattern)) {
      return true;
    }

    const maxLength = el.maxLength;
    return typeof maxLength === 'number' && maxLength >= 10 && maxLength <= 17;
  }

  /** The characters a formatter has to preserve for a value to be the same answer. */
  function comparableCharacters(value) {
    return String(value).replace(/[^0-9a-z]/gi, '').toLowerCase();
  }

  /**
   * Judge what the page kept of the value we set.
   * Identical → filled. Same digits/letters in the same order → filled, but the
   * site rewrote the formatting (a phone mask is the usual reason), which the
   * caller surfaces instead of silently accepting. Anything else is a failure:
   * a value that stops short of the requested characters was truncated, the
   * rest was rewritten into something we did not ask for.
   * @returns {{ ok: boolean, reformatted?: boolean, reason?: string, landed_value?: string }}
   */
  function classifyFilledValue(requested, landed) {
    const wanted = String(requested);
    const got = String(landed);
    if (got === wanted) return { ok: true };

    const wantedChars = comparableCharacters(wanted);
    const gotChars = comparableCharacters(got);
    if (wantedChars && wantedChars === gotChars) {
      return { ok: true, reformatted: true, landed_value: got };
    }
    if (!gotChars && wantedChars) {
      return { ok: false, reason: 'The site rejected this value.' };
    }
    if (gotChars && wantedChars.startsWith(gotChars)) {
      return { ok: false, reason: 'The site truncated this value.', landed_value: got };
    }
    return { ok: false, reason: `The site reformatted this value to “${got}”.`, landed_value: got };
  }

  /** Write a value through the page's own setter, then fire the events it listens for. */
  function writeInputValue(el, value) {
    const setter = el.tagName === 'TEXTAREA'
      ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
    dispatchEvents(el, ['input', 'change', 'blur']);
  }

  /**
   * Fill a text input, textarea, or contenteditable element.
   * Uses native input setter to bypass React's synthetic event system.
   *
   * The page may run a formatter of its own over the value (Greenhouse's phone
   * mask turned "+1 555 0100" into "+1 555-010-0"), so verification judges what
   * the page kept rather than demanding byte equality. A phone-shaped value
   * whose separators the site discarded is retried once, digits-only, and a
   * masked control gets one delayed re-read because its formatter may run
   * after our write — never on the ordinary path, which returns as soon as the
   * value matches.
   * @returns {Promise<{ ok: boolean, reformatted?: boolean, reason?: string, landed_value?: string }>}
   */
  async function fillTextInput(el, value) {
    const requested = String(value);
    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      // Focus can be blocked by the page; the value is still worth attempting.
    }

    if (el.hasAttribute('contenteditable')) {
      el.textContent = requested;
      dispatchEvents(el, ['input', 'change', 'blur']);
      const verdict = classifyFilledValue(requested, el.textContent);
      // Same rule as the masked inputs: an editor that reformats on its own
      // gets one delayed re-read, and only when the first read disagrees.
      if (verdict.ok) return verdict;
      await new Promise((resolve) => setTimeout(resolve, MASK_SETTLE_MS));
      return classifyFilledValue(requested, el.textContent);
    }

    // Typed inputs run a value-sanitisation algorithm and silently drop a
    // non-conforming string ("5+ years" into number, "MM/DD/YYYY" into date),
    // so normalise what we know and verify what landed below.
    const target = el.type === 'date' ? (normaliseDateValue(requested) ?? requested) : requested;
    const masked = looksLikePhoneValue(target) && phoneMaskControl(el);

    writeInputValue(el, target);
    let verdict = classifyFilledValue(target, el.value);

    // Only a phone number that did not already land is rewritten digits-only:
    // it is the shape a mask accepts when it refuses our separators. A value
    // the input rejected for any other reason ("5+ years" into number) never
    // takes this path, so it stays a failure.
    if (!verdict.ok && masked) {
      const digits = target.replace(/\D/g, '');
      if (digits && digits !== target) {
        writeInputValue(el, digits);
        verdict = classifyFilledValue(target, el.value);
      }
    }

    // A masked control's formatter can still rewrite the value after the event
    // we dispatched has been handled, so an early match is not yet proof there.
    if (verdict.ok && !masked) return verdict;
    await new Promise((resolve) => setTimeout(resolve, MASK_SETTLE_MS));
    return classifyFilledValue(target, el.value);
  }

  /**
   * Select an option in a <select> element by matching text.
   */
  async function fillSelect(el, value) {
    if (el.tagName !== 'SELECT') {
      // Might be a custom dropdown — try clicking and searching
      return await fillCustomDropdown(el, value);
    }

    const options = Array.from(el.options);
    const valueLower = value.toLowerCase().trim();

    // Try exact match first
    let match = options.find(
      (opt) => opt.textContent.trim().toLowerCase() === valueLower
    );

    // Try partial match
    if (!match) {
      match = options.find(
        (opt) => opt.textContent.trim().toLowerCase().includes(valueLower) ||
                 valueLower.includes(opt.textContent.trim().toLowerCase())
      );
    }

    // Try value attribute match
    if (!match) {
      match = options.find(
        (opt) => opt.value.toLowerCase() === valueLower
      );
    }

    if (match) {
      el.value = match.value;
      dispatchEvents(el, ['focus', 'change', 'input', 'blur']);
      return true;
    }

    console.warn(`[AutoApply] No matching option for "${value}" in select ${el.id}`);
    return false;
  }

  /**
   * Attempt to fill a custom dropdown (non-native select).
   */
  function fillCustomDropdown(el, value) {
    return new Promise((resolve) => {
      // Click the dropdown to open it
      el.click();

      // Wait a moment for options to render
      setTimeout(async () => {
        const valueLower = value.toLowerCase().trim();

        // Look for dropdown options near the element
        const optionSelectors = [
          '[role="option"]', '[role="listbox"] li',
          '.dropdown-item', '.select-option', '.option',
          'li[data-value]', '[class*="option"]', '[class*="MenuItem"]',
        ];

        for (const sel of optionSelectors) {
          const options = document.querySelectorAll(sel);
          for (const opt of options) {
            if (opt.textContent.trim().toLowerCase().includes(valueLower)) {
              opt.click();
              resolve(true);
              return;
            }
          }
        }

        // Try typing into it if it's an input
        if (el.tagName === 'INPUT') {
          resolve((await fillTextInput(el, value)).ok);
        } else {
          resolve(false);
        }
      }, 300);
    });
  }

  /**
   * Check/uncheck a checkbox or pick the requested member of a radio group.
   * The requested value is paired with the element it belongs to — the shared
   * findLabel and the input's own value — so a group can never end up with a
   * different option selected than the one that was asked for. Returns false
   * when this group has no such option, so the row reports a failure.
   */
  function fillCheckbox(el, value) {
    const type = (el.type || '').toLowerCase();
    if (type !== 'radio' && type !== 'checkbox') return false;

    const valueLower = String(value ?? '').toLowerCase().trim();
    if (!valueLower) return false;

    const matchOption = (input) => {
      const label = (findLabel(input) || '').toLowerCase().trim();
      const ownValue = String(input.value ?? '').toLowerCase().trim();
      // Only the label-contains-value direction is tolerant: the reverse would
      // let "Not a real option" match a "No" radio.
      return {
        exact: label === valueLower || ownValue === valueLower,
        partial: Boolean(label) && label.includes(valueLower),
      };
    };
    const select = (input, checked) => {
      input.checked = checked;
      dispatchEvents(input, ['change']);
      return true;
    };

    if (el.name) {
      const group = Array.from(document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`))
        .filter((input) => (input.type || '').toLowerCase() === type);
      // Exact matches win over partial ones, whatever order the group is in.
      for (const pass of ['exact', 'partial']) {
        for (const input of group) {
          if (matchOption(input)[pass]) return select(input, true);
        }
      }
      // The requested choice does not exist in this group: report it rather
      // than guessing, which would invert answers on legal questions.
      return false;
    }

    // Ungrouped element: it has to be the requested choice itself, or a plain
    // boolean state for a lone checkbox.
    if (matchOption(el).exact || matchOption(el).partial) return select(el, true);
    if (valueLower === 'true' || valueLower === 'yes') return select(el, true);
    if (valueLower === 'false' || valueLower === 'no') return select(el, false);
    return false;
  }

  /**
   * The element to outline for an upload field.
   *
   * Never a broad container: an element that holds other form controls is the
   * step's own wrapper, and outlining it would cover the sibling fields and
   * (if the page hid the step) make a hidden step visible again.
   */
  function uploadHighlightTarget(el) {
    const label = associatedLabel(el);
    if (label && holdsOnlyUpload(label, el) && isRenderedControl(label)) return label;

    const parent = el.parentElement;
    if (parent && holdsOnlyUpload(parent, el) && isRenderedControl(parent)) return parent;

    // Fall back to the control itself: touching anything above it risks the
    // page's own layout, and the panel message still explains what to attach.
    return el;
  }

  /** A label tied to the input, either by `for` or by wrapping it. */
  function associatedLabel(el) {
    const explicit = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return explicit || el.closest('label');
  }

  /** True when nothing else in `node` is a form control. */
  function holdsOnlyUpload(node, el) {
    if (!node || node === document.body || node === document.documentElement) return false;
    const controls = node.querySelectorAll('input, select, textarea, button').length;
    return controls === (node.contains(el) ? 1 : 0);
  }

  function uploadHighlightStyleTag() {
    return document.getElementById('autoapply-upload-style');
  }

  /**
   * Highlight a file upload field to draw user attention.
   *
   * The cue is a class plus rules in our own stylesheet, never inline styles:
   * the page owns its `style` attribute, and rewriting it dropped properties
   * the page set later (a `display:none` step became visible again).
   *
   * With `all_frames` this runs inside iframes too. Everything here is
   * frame-scoped by construction — `document` is the frame's own document, so
   * the class and the stylesheet never reach the top page — and a frame whose
   * document has no `<head>` (srcdoc/about:blank) still gets the stylesheet
   * appended to its root element.
   */
  function highlightUploadField(el) {
    const target = uploadHighlightTarget(el);
    if (!target) return;
    target.classList.add(UPLOAD_HIGHLIGHT_CLASS);

    if (!uploadHighlightStyleTag()) {
      const style = document.createElement('style');
      style.id = 'autoapply-upload-style';
      style.textContent = `
        @keyframes autoapply-pulse {
          0%, 100% { outline-color: #ea6a4f; }
          50% { outline-color: #3f8a96; }
        }
        .${UPLOAD_HIGHLIGHT_CLASS} {
          outline: 3px solid #ea6a4f !important;
          outline-offset: 2px !important;
          border-radius: 4px !important;
          animation: autoapply-pulse 2s ease-in-out infinite !important;
        }
      `;
      const root = document.head || document.documentElement;
      if (root) root.appendChild(style);
    }
  }

  /**
   * Undo highlightUploadField: drop the class and the injected stylesheet.
   * Nothing else was touched, so the host page keeps every inline property it
   * set in the meantime.
   */
  function clearUploadHighlight() {
    document.querySelectorAll(`.${UPLOAD_HIGHLIGHT_CLASS}`).forEach((marked) => {
      marked.classList.remove(UPLOAD_HIGHLIGHT_CLASS);
    });

    const styleTag = uploadHighlightStyleTag();
    if (styleTag) styleTag.remove();
  }

  /**
   * Fill all fields from an array of instructions.
   * @param {Array} instructions - Array of fill instructions
   * @returns {{ filled: number, skipped: number, failed: number, failures: Array, reformatted: Array }}
   */
  async function fillAllFields(instructions, options = {}) {
    let filled = 0, skipped = 0, failed = 0;
    const failures = [];
    const reformatted = [];

    for (const instruction of instructions) {
      if (instruction.action === 'skip') {
        skipped++;
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay between fields

      const outcome = await fillField(instruction, options);
      if (outcome.ok) {
        filled++;
        // The answer is right but the site rewrote its formatting; the panel
        // mentions these rather than passing them off as an exact write.
        if (outcome.reformatted) {
          reformatted.push({ field_id: instruction.field_id, value: outcome.landed_value });
        }
      } else {
        failed++;
        failures.push({
          field_id: instruction.field_id,
          action: instruction.action,
          reason: outcome.reason || 'The field could not be filled.',
        });
      }
    }

    console.log(`[AutoApply] Fill complete: ${filled} filled, ${skipped} skipped, ${failed} failed`);
    return { filled, skipped, failed, failures, reformatted };
  }

  /**
   * Find and click a conservative Next/Continue control.
   * @returns {boolean} True if a button was found and clicked
   */
  function clickNextButton() {
    const pageState = isLastPage();
    if (pageState.isLast || pageState.isAmbiguous) {
      console.warn(`[AutoApply] Refusing to advance: ${pageState.reason}`);
      return false;
    }

    // Only explicit non-submit controls with an unambiguous next label may be clicked.
    const matches = navigationControls()
      .filter(isSafeNextControl)
      .map((btn) => {
        const text = controlText(btn);
        const matchedTarget = NEXT_BUTTON_TEXTS.find((target) => text.includes(target));
        const isPrimary =
          btn.classList.contains('primary') ||
          btn.classList.contains('btn-primary') ||
          btn.getAttribute('data-automation-id')?.includes('bottom') ||
          getComputedStyle(btn).backgroundColor !== 'rgba(0, 0, 0, 0)';
        return {
          el: btn,
          text,
          isPrimary,
          priority: NEXT_BUTTON_TEXTS.indexOf(matchedTarget),
        };
      });

    if (matches.length === 0) {
      console.warn('[AutoApply] No next/continue button found');
      return false;
    }

    // Sort: primary first, then by priority in NEXT_BUTTON_TEXTS.
    matches.sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return a.priority - b.priority;
    });

    const best = matches[0];
    // Re-check immediately before the side effect in case the page mutated.
    if (!isSafeNextControl(best.el)) {
      console.warn('[AutoApply] Refusing to click a control that became submit-like.');
      return false;
    }
    console.log(`[AutoApply] Clicking safe navigation button: "${best.text}"`);
    best.el.click();
    // The page is about to change: the cached page text is no longer current.
    cachedBodyText = null;
    return true;
  }

  function formFieldCount() {
    return document.querySelectorAll('input, select, textarea').length;
  }

  /**
   * Set up a MutationObserver to detect when the form changes (new step).
   * @param {Function} callback - Called when a new step is detected
   * @returns {{ disconnect: Function, cancel: Function }} Handle; cancel()
   *   also clears the pending debounce so no timer can fire after teardown.
   */
  function detectPageChange(callback) {
    let lastFieldCount = formFieldCount();
    let timer = null;

    const observer = new MutationObserver(() => {
      // Any mutation may change the rendered text; drop the cached copy.
      cachedBodyText = null;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const currentFieldCount = formFieldCount();

        // Significant DOM change — likely a new form step
        if (Math.abs(currentFieldCount - lastFieldCount) >= 2) {
          lastFieldCount = currentFieldCount;
          console.log('[AutoApply] Page change detected, re-scanning...');
          callback();
        }
      }, 800);
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });

    return {
      disconnect() {
        observer.disconnect();
      },
      cancel() {
        clearTimeout(timer);
        timer = null;
        observer.disconnect();
      },
    };
  }

  /**
   * Determine if the current page is likely the last page of the application form.
   * @returns {{ isLast: boolean, reason: string }}
   */
  function isLastPage() {
    // Signal 1: An explicit submit-like control is a hard safety boundary. A
    // page may contain both "Next" and "Submit" controls, so do not guess.
    const allButtons = [
      ...navigationControls(),
      ...document.querySelectorAll('input[type="submit"]'),
      ...document.querySelectorAll('input[type="image"]'),
    ];
    const visibleButtons = allButtons.filter(
      (btn) => isRenderedControl(btn) && !btn.disabled && !btn.closest('.autoapply-overlay')
    );
    const hasSubmitButton = visibleButtons.some(isSubmitLikeControl);
    const hasSafeNextButton = visibleButtons.some(isSafeNextControl);
    
    // Signal 2: Check for progress indicators (e.g., "Step 5 of 5")
    const stepMatch = bodyText().match(/step\s+(\d+)\s+of\s+(\d+)/i);
    let progressComplete = false;
    if (stepMatch && stepMatch[1] === stepMatch[2]) {
      progressComplete = true;
    }
    
    // Signal 3: Count input fields (review pages have very few)
    const inputCount = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea'
    ).length;
    const isReviewPage = inputCount <= 2;
    
    // Decision logic
    const isLast = hasSubmitButton || progressComplete || (!hasSafeNextButton && isReviewPage);
    const isAmbiguous = !isLast && !hasSafeNextButton;
    
    const reasons = [];
    if (hasSubmitButton) reasons.push('submit-like control found');
    if (progressComplete) reasons.push('progress indicator shows final step');
    if (!hasSafeNextButton && isReviewPage) reasons.push('no safe next button and very few input fields');
    if (isAmbiguous) reasons.push('no unambiguous non-submit next button found');

    return {
      isLast,
      isAmbiguous,
      reason: reasons.join('; ') || 'safe next/continue button available'
    };
  }

  /**
   * Find the label text for a form element using multiple strategies.
   * This is the single resolver shared with the scraper, so the options the
   * backend sees and the options the filler matches are always the same text.
   * @param {HTMLElement} el
   * @returns {string|null} Label text
   */
  function findLabel(el) {
    // Strategy 1: Explicit <label for="...">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return cleanLabelText(label.textContent);
    }

    // Strategy 2: aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return cleanLabelText(labelEl.textContent);
    }

    // Strategy 3: aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return cleanLabelText(ariaLabel);

    // Strategy 4: Wrapping <label> parent
    const parentLabel = el.closest('label');
    if (parentLabel) {
      // Get text that isn't from the input itself
      const clone = parentLabel.cloneNode(true);
      const inputs = clone.querySelectorAll('input, select, textarea');
      inputs.forEach((i) => i.remove());
      const text = cleanLabelText(clone.textContent);
      if (text) return text;
    }

    // Strategy 5: Previous sibling label
    let prev = el.previousElementSibling;
    while (prev) {
      if (prev.tagName === 'LABEL' || prev.classList.contains('label')) {
        return cleanLabelText(prev.textContent);
      }
      prev = prev.previousElementSibling;
    }

    // Strategy 6: Parent's previous sibling or child heading
    const parent = el.parentElement;
    if (parent) {
      // Look for a label-like element in the parent
      const labelLike = parent.querySelector(
        'label, .label, .field-label, .form-label, [class*="label"]'
      );
      if (labelLike && !labelLike.contains(el)) {
        return cleanLabelText(labelLike.textContent);
      }

      // Look at parent's parent for label
      const grandParent = parent.parentElement;
      if (grandParent) {
        const gpLabel = grandParent.querySelector(
          'label, .label, .field-label, .form-label, [class*="label"]'
        );
        if (gpLabel && !gpLabel.contains(el)) {
          return cleanLabelText(gpLabel.textContent);
        }
      }
    }

    // Strategy 7: Placeholder or name as fallback
    if (el.placeholder) return cleanLabelText(el.placeholder);
    if (el.name) return cleanLabelText(el.name.replace(/[_-]/g, ' '));

    return null;
  }

  /**
   * Clean up label text (trim, remove asterisks, collapse whitespace).
   * @param {string} text
   * @returns {string} Cleaned text
   */
  function cleanLabelText(text) {
    return text
      .replace(/\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Dispatch native events on an element for framework compatibility.
   */
  function dispatchEvents(el, eventNames) {
    for (const name of eventNames) {
      if (name === 'focus') {
        el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
      } else if (name === 'input') {
        try {
          el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));
        } catch (e) {
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        }
      } else if (name === 'change') {
        el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      } else if (name === 'blur') {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      } else if (name === 'click') {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    }
  }

  return {
    fillField,
    fillAllFields,
    highlightUploadField,
    clearUploadHighlight,
    clickNextButton,
    detectPageChange,
    isLastPage,
    bodyText,
    findLabel,
    isRenderedControl,
  };
})();

if (typeof window !== 'undefined') {
  window.__autoapply_filler = AutoApplyFiller;
}
