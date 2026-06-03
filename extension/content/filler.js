/**
 * AutoApply — Form Filler
 * Programmatically fills form fields and handles navigation.
 */

const AutoApplyFiller = (() => {
  /**
   * Fill a single form field based on an instruction.
   * Dispatches proper events for React/Angular/Vue framework compatibility.
   * @param {Object} instruction - Fill instruction from backend
   * @returns {boolean} True if filled successfully
   */
  async function fillField(instruction) {
    const { field_id, action, value } = instruction;
    if (action === 'skip' || value === undefined || value === null) return false;

    // Find the element by ID or data attribute
    let el = document.getElementById(field_id);
    if (!el) {
      el = document.querySelector(`[data-autoapply-id="${CSS.escape(field_id)}"]`);
    }
    if (!el) {
      console.warn(`[AutoApply] Field not found: ${field_id}`);
      return false;
    }

    try {
      switch (action) {
        case 'fill':
          return fillTextInput(el, value);

        case 'select':
          return await fillSelect(el, value);

        case 'check':
          return fillCheckbox(el, value);

        case 'upload':
          // Highlight the upload field — user must select the file manually
          highlightUploadField(el);
          return true;

        default:
          console.warn(`[AutoApply] Unknown action: ${action}`);
          return false;
      }
    } catch (err) {
      console.error(`[AutoApply] Error filling ${field_id}:`, err);
      return false;
    }
  }

  /**
   * Fill a text input, textarea, or contenteditable element.
   * Uses native input setter to bypass React's synthetic event system.
   */
  function fillTextInput(el, value) {
    if (el.hasAttribute('contenteditable')) {
      el.textContent = value;
      dispatchEvents(el, ['focus', 'input', 'change', 'blur']);
      return true;
    }

    // Use native value setter to work with React controlled components
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, 'value'
    )?.set;

    const setter = el.tagName === 'TEXTAREA' ? nativeTextareaValueSetter : nativeInputValueSetter;

    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }

    dispatchEvents(el, ['focus', 'input', 'change', 'blur']);
    return true;
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
      setTimeout(() => {
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
          fillTextInput(el, value);
          resolve(true);
        } else {
          resolve(false);
        }
      }, 300);
    });
  }

  /**
   * Check/uncheck a checkbox or select a radio button.
   */
  function fillCheckbox(el, value) {
    const valueLower = (value || '').toLowerCase().trim();

    if (el.type === 'radio' || el.type === 'checkbox') {
      // If there's a group, find the right one by label
      if (el.name) {
        const group = document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`);
        for (const input of group) {
          const label = findNearestLabelText(input);
          if (
            label.toLowerCase().includes(valueLower) ||
            input.value.toLowerCase() === valueLower
          ) {
            input.checked = true;
            dispatchEvents(input, ['change']);
            return true;
          }
        }
      }

      // Simple check
      el.checked = valueLower !== 'false' && valueLower !== 'no' && valueLower !== '';
      dispatchEvents(el, ['change']);
      return true;
    }

    return false;
  }

  /**
   * Highlight a file upload field to draw user attention.
   */
  function highlightUploadField(el) {
    const wrapper = el.closest('div') || el.parentElement || el;
    wrapper.style.outline = '3px solid #667eea';
    wrapper.style.outlineOffset = '2px';
    wrapper.style.borderRadius = '4px';
    wrapper.style.animation = 'autoapply-pulse 2s ease-in-out infinite';

    // Add pulse animation if not already present
    if (!document.getElementById('autoapply-upload-style')) {
      const style = document.createElement('style');
      style.id = 'autoapply-upload-style';
      style.textContent = `
        @keyframes autoapply-pulse {
          0%, 100% { outline-color: #667eea; }
          50% { outline-color: #764ba2; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  /**
   * Fill all fields from an array of instructions.
   * @param {Array} instructions - Array of fill instructions
   * @returns {{ filled: number, skipped: number, failed: number }}
   */
  async function fillAllFields(instructions) {
    let filled = 0, skipped = 0, failed = 0;

    for (const instruction of instructions) {
      if (instruction.action === 'skip') {
        skipped++;
        continue;
      }

      await new Promise(resolve => setTimeout(resolve, 50)); // Small delay between fields

      const success = await fillField(instruction);
      if (success) {
        filled++;
      } else {
        failed++;
      }
    }

    console.log(`[AutoApply] Fill complete: ${filled} filled, ${skipped} skipped, ${failed} failed`);
    return { filled, skipped, failed };
  }

  /**
   * Find and click the Next/Continue/Submit button.
   * @returns {boolean} True if a button was found and clicked
   */
  function clickNextButton() {
    const buttonTexts = [
      'next', 'continue', 'save & continue', 'save and continue',
      'proceed', 'submit application', 'apply', 'save & next',
      'save and next', 'forward',
    ];

    // Look for buttons and inputs
    const candidates = [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('input[type="submit"]'),
      ...document.querySelectorAll('a[role="button"]'),
      ...document.querySelectorAll('[role="button"]'),
    ];

    // Filter for visible, likely next buttons
    const matches = [];
    for (const btn of candidates) {
      if (btn.offsetParent === null) continue; // Hidden
      if (btn.disabled) continue;
      if (btn.closest('.autoapply-overlay')) continue; // Our overlay

      const text = (btn.textContent || btn.value || '').toLowerCase().trim();

      for (const target of buttonTexts) {
        if (text.includes(target)) {
          // Prefer primary/highlighted buttons
          const isPrimary =
            btn.classList.contains('primary') ||
            btn.classList.contains('btn-primary') ||
            btn.getAttribute('data-automation-id')?.includes('bottom') ||
            getComputedStyle(btn).backgroundColor !== 'rgba(0, 0, 0, 0)';

          matches.push({ el: btn, text, isPrimary, priority: buttonTexts.indexOf(target) });
          break;
        }
      }
    }

    if (matches.length === 0) {
      console.warn('[AutoApply] No next/continue button found');
      return false;
    }

    // Sort: primary first, then by priority in buttonTexts list
    matches.sort((a, b) => {
      if (a.isPrimary && !b.isPrimary) return -1;
      if (!a.isPrimary && b.isPrimary) return 1;
      return a.priority - b.priority;
    });

    const best = matches[0];
    console.log(`[AutoApply] Clicking button: "${best.text}"`);
    best.el.click();
    return true;
  }

  /**
   * Set up a MutationObserver to detect when the form changes (new step).
   * @param {Function} callback - Called when a new step is detected
   * @returns {MutationObserver} The observer (call .disconnect() to stop)
   */
  function detectPageChange(callback) {
    let lastFieldCount = document.querySelectorAll('input, select, textarea').length;

    const observer = new MutationObserver(
      AutoApplyUtils.debounce(() => {
        const currentFieldCount = document.querySelectorAll('input, select, textarea').length;

        // Significant DOM change — likely a new form step
        if (Math.abs(currentFieldCount - lastFieldCount) >= 2) {
          lastFieldCount = currentFieldCount;
          console.log('[AutoApply] Page change detected, re-scanning...');
          callback();
        }
      }, 800)
    );

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return observer;
  }

  /**
   * Determine if the current page is likely the last page of the application form.
   * @returns {{ isLast: boolean, reason: string }}
   */
  function isLastPage() {
    // Signal 1: Check button text
    const submitKeywords = [
      'submit application', 'submit', 'apply now', 'send application',
      'confirm application', 'review and submit', 'complete application',
      'finish', 'final submit'
    ];
    const nextKeywords = [
      'next', 'continue', 'save & continue', 'save and continue',
      'proceed', 'save & next', 'save and next', 'forward'
    ];
    
    const allButtons = [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('input[type="submit"]'),
      ...document.querySelectorAll('[role="button"]'),
    ];
    
    let hasSubmitButton = false;
    let hasNextButton = false;
    
    for (const btn of allButtons) {
      if (btn.offsetParent === null || btn.disabled) continue;
      const text = (btn.textContent || btn.value || '').toLowerCase().trim();
      if (submitKeywords.some(kw => text.includes(kw))) hasSubmitButton = true;
      if (nextKeywords.some(kw => text.includes(kw))) hasNextButton = true;
    }
    
    // Signal 2: Check for progress indicators (e.g., "Step 5 of 5")
    const bodyText = document.body.innerText;
    const stepMatch = bodyText.match(/step\s+(\d+)\s+of\s+(\d+)/i);
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
    const isLast = (hasSubmitButton && !hasNextButton) 
                || progressComplete 
                || (!hasNextButton && isReviewPage);
    
    const reasons = [];
    if (hasSubmitButton && !hasNextButton) reasons.push('submit button found, no next button');
    if (progressComplete) reasons.push('progress indicator shows final step');
    if (!hasNextButton && isReviewPage) reasons.push('no next button and very few input fields');
    if (!hasNextButton && !hasSubmitButton) reasons.push('no navigation buttons found');
    
    return {
      isLast,
      reason: reasons.join('; ') || 'next/continue button available'
    };
  }

  /**
   * Find the nearest label text for an element.
   */
  function findNearestLabelText(el) {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent.trim();
    }
    const parent = el.closest('label');
    if (parent) return parent.textContent.trim();
    const prev = el.previousElementSibling;
    if (prev) return prev.textContent.trim();
    return el.value || '';
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

  return { fillField, fillAllFields, clickNextButton, detectPageChange, isLastPage };
})();

if (typeof window !== 'undefined') {
  window.__autoapply_filler = AutoApplyFiller;
}
