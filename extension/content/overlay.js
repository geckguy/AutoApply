/**
 * AutoApply — Review Overlay UI Orchestrator
 * Injected as a content script. Creates the floating glassmorphism panel,
 * coordinates scraper → backend → filler, and handles user interactions.
 */

(() => {
  // Prevent multiple initializations in the same tab session
  if (window.__autoapply_overlay_initialized) return;
  window.__autoapply_overlay_initialized = true;

  const UTILS = window.__autoapply_utils;
  const SCRAPER = window.__autoapply_scraper_module;
  const FILLER = window.__autoapply_filler;

  if (!UTILS || !SCRAPER || !FILLER) {
    console.error('[AutoApply] Required modules not loaded. Ensure script load order: utils.js -> scraper.js -> filler.js -> overlay.js');
    return;
  }

  let shadowHost = null;
  let shadowRoot = null;
  let overlayContainer = null;
  let currentInstructions = [];
  let originalInstructionsMap = new Map(); // field_id -> original agent value
  let jobAnalysis = null;
  let companyName = '';
  let roleName = '';
  let isMinimized = false;
  let activeObserver = null;
  let pageFields = []; // Cached fields from scraper
  let jdText = ''; // Cached job description
  let cachedDuplicateRes = null; // Cached duplicate response
  let autopilotActive = false;
  let autopilotStep = 0;
  const MAX_AUTOPILOT_STEPS = 15;

  // Drag state
  let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;
  let dragMoveHandler = null;
  let dragUpHandler = null;

  /**
   * Start the scan, analysis, and fill-preparation flow.
   */
  async function startScanningFlow() {
    window.__autoapply_active = true;
    removeOverlay();

    // Create shadow DOM host to isolate overlay from host page CSS
    shadowHost = document.createElement('div');
    shadowHost.id = 'autoapply-shadow-host';
    document.body.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    // Fetch overlay CSS and inject into shadow root
    try {
      const cssUrl = browser.runtime.getURL('content/overlay.css');
      const cssResponse = await fetch(cssUrl);
      const cssText = await cssResponse.text();
      const styleEl = document.createElement('style');
      styleEl.textContent = cssText;
      shadowRoot.appendChild(styleEl);
    } catch (err) {
      console.warn('[AutoApply] Could not load overlay CSS into shadow root:', err);
    }

    // Create the overlay container element inside shadow root
    overlayContainer = document.createElement('div');
    overlayContainer.className = 'autoapply-overlay';
    shadowRoot.appendChild(overlayContainer);

    showLoading('Scanning form & analyzing job fit...');

    try {
      const scrapeResult = SCRAPER.scrapeFormFields();
      pageFields = scrapeResult.fields;
      jdText = scrapeResult.job_description;
    } catch (err) {
      console.error('[AutoApply] Scraper error:', err);
      showError('Failed to scan page fields. Check console for details.');
      return;
    }

    const url = window.location.href;
    const title = document.title;
    const platform = UTILS.detectPlatform(url);
    companyName = UTILS.extractCompany(url, title);
    
    // Extract a cleaner role name from the page title
    roleName = title
      .split(/ - | at | \| /i)[0]
      .replace(/Apply for|Job Application for|Opening for/i, '')
      .trim();

    const formSchema = {
      url,
      platform,
      page_title: title,
      step: 1,
      total_steps: 1,
      fields: pageFields,
      job_description: jdText
    };

    // Sequential calls to backend to avoid rate limiting
    const executeBackendCalls = async () => {
      try {
        cachedDuplicateRes = await UTILS.apiCall(
          `/api/applications/check-duplicate?url=${encodeURIComponent(url)}&company=${encodeURIComponent(companyName)}&role=${encodeURIComponent(roleName)}`
        );
        
        const autofillRes = await UTILS.apiCall('/api/autofill', 'POST', formSchema);
        
        currentInstructions = autofillRes.instructions || [];
        
        // Cache original values to track corrections
        originalInstructionsMap.clear();
        currentInstructions.forEach(inst => {
          originalInstructionsMap.set(inst.field_id, inst.value);
        });

        renderMainUI();
      } catch (err) {
        console.error('[AutoApply] Backend connection error:', err);
        if (err.message.includes('404')) {
          showError('No profile loaded. Please open the extension popup and upload your resume first!');
        } else if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
          showError('Cannot connect to AutoApply backend. Please make sure the local server is running on port 8000.');
        } else {
          showError(`Error contacting backend: ${err.message}`);
        }
      }
    };

    await executeBackendCalls();
  }

  /**
   * Remove the overlay element from DOM and cleanup observer.
   */
  function removeOverlay() {
    if (dragMoveHandler) {
      document.removeEventListener('mousemove', dragMoveHandler);
      document.removeEventListener('mouseup', dragUpHandler);
      dragMoveHandler = null;
      dragUpHandler = null;
    }
    if (shadowHost) {
      shadowHost.remove();
      shadowHost = null;
      shadowRoot = null;
      overlayContainer = null;
    }
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }
    window.__autoapply_active = false;
  }

  /**
   * Display loading spinner inside the overlay.
   */
  function showLoading(text) {
    if (!overlayContainer) return;
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          <div class="autoapply-logo-icon">A</div>
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-loading">
        <div class="autoapply-spinner"></div>
        <div class="autoapply-loading-text">${UTILS.escapeHTML(text)}</div>
      </div>
    `;

    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', removeOverlay);
  }

  /**
   * Display error message inside the overlay.
   */
  function showError(msg) {
    if (!overlayContainer) return;
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          <div class="autoapply-logo-icon">A</div>
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-error">
        ${UTILS.escapeHTML(msg)}
      </div>
    `;

    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', removeOverlay);
  }

  /**
   * Render the main review layout of the extension overlay.
   */
  function renderMainUI() {
    if (!overlayContainer) return;

    if (isMinimized) {
      renderMinimizedUI();
      return;
    }

    // Build the container HTML structure
    overlayContainer.className = 'autoapply-overlay';
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          <div class="autoapply-logo-icon">A</div>
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-minimize-btn" title="Minimize">─</button>
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>

      ${renderDuplicateWarning(cachedDuplicateRes)}
      ${renderFitScoreSection()}

      <div class="autoapply-step-indicator">
        Review Autofill Fields (${pageFields.length} found)
      </div>

      <div class="autoapply-fields">
        ${pageFields.map((field, idx) => renderFieldRow(field, idx)).join('')}
      </div>

      <div class="autoapply-footer">
        <button class="autoapply-btn autoapply-btn-secondary autoapply-fill-only-btn">Fill Only</button>
        <button class="autoapply-btn autoapply-btn-primary autoapply-advance-btn">Fill & Next ➔</button>
        <button class="autoapply-btn autoapply-autopilot-btn">AutoPilot</button>
      </div>
    `;

    // Wire up events
    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', removeOverlay);
    overlayContainer.querySelector('.autoapply-minimize-btn').addEventListener('click', toggleMinimize);

    // Enable drag
    setupDrag();

    // Analyze button event
    const analyzeBtn = overlayContainer.querySelector('.autoapply-analyze-btn');
    if (analyzeBtn) {
      analyzeBtn.addEventListener('click', async () => {
        analyzeBtn.textContent = 'Analyzing...';
        analyzeBtn.disabled = true;
        try {
          jobAnalysis = await UTILS.apiCall('/api/analyze-job', 'POST', { job_description: jdText });
          renderMainUI();
        } catch (err) {
          analyzeBtn.textContent = 'Failed';
          console.error('[AutoApply] Analyze Job failed:', err);
        }
      });
    }

    // Edit button events
    overlayContainer.querySelectorAll('.autoapply-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        startEditingField(idx);
      });
    });

    // Expand/collapse toggle events
    overlayContainer.querySelectorAll('.autoapply-expand-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        const valDiv = overlayContainer.querySelector(`#val_${idx}`);
        if (!valDiv) return;
        const isExpanded = valDiv.classList.toggle('expanded');
        e.currentTarget.textContent = isExpanded ? '▲ less' : '▼ more';
      });
    });

    // Action button events
    overlayContainer.querySelector('.autoapply-fill-only-btn').addEventListener('click', () => {
      handleFill(false);
    });

    overlayContainer.querySelector('.autoapply-advance-btn').addEventListener('click', () => {
      handleFill(true);
    });

    overlayContainer.querySelector('.autoapply-autopilot-btn').addEventListener('click', () => {
      runAutoPilot();
    });

    // Cover letter button events
    overlayContainer.querySelectorAll('.autoapply-gen-cover-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        await generateCoverLetter(idx, e.currentTarget);
      });
    });
  }

  /**
   * Renders the minimized toggle button.
   */
  function renderMinimizedUI() {
    overlayContainer.className = 'autoapply-overlay autoapply-minimized';
    overlayContainer.innerHTML = `
      <div class="autoapply-mini-btn">
        <div class="autoapply-logo-icon">A</div>
        <span>AutoApply (Click to Expand)</span>
      </div>
    `;
    overlayContainer.querySelector('.autoapply-mini-btn').addEventListener('click', toggleMinimize);
  }

  /**
   * Toggle between minimized and expanded overlay views.
   */
  function toggleMinimize() {
    isMinimized = !isMinimized;
    // Force a re-render of the active state
    if (overlayContainer) {
      if (overlayContainer.querySelector('.autoapply-loading') || overlayContainer.querySelector('.autoapply-error')) {
        // Don't minimize during loading or error states
        isMinimized = false;
        return;
      }
      // Re-trigger render
      renderMainUI();
    }
  }

  /**
   * Enable dragging the overlay by its header bar.
   */
  function setupDrag() {
    // Remove previous handlers if any
    if (dragMoveHandler) {
      document.removeEventListener('mousemove', dragMoveHandler);
      document.removeEventListener('mouseup', dragUpHandler);
    }

    if (!overlayContainer) return;
    const header = overlayContainer.querySelector('.autoapply-header');
    if (!header) return;

    header.addEventListener('mousedown', (e) => {
      // Don't drag if clicking buttons
      if (e.target.closest('.autoapply-header-btn')) return;

      isDragging = true;
      const rect = overlayContainer.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      overlayContainer.classList.add('autoapply-dragging');
      e.preventDefault();
    });

    dragMoveHandler = (e) => {
      if (!isDragging || !overlayContainer) return;
      const newLeft = e.clientX - dragOffsetX;
      const newTop = e.clientY - dragOffsetY;
      overlayContainer.style.left = `${Math.max(0, newLeft)}px`;
      overlayContainer.style.top = `${Math.max(0, newTop)}px`;
      overlayContainer.style.right = 'auto';
    };

    dragUpHandler = () => {
      if (!isDragging) return;
      isDragging = false;
      if (overlayContainer) {
        overlayContainer.classList.remove('autoapply-dragging');
      }
    };

    document.addEventListener('mousemove', dragMoveHandler);
    document.addEventListener('mouseup', dragUpHandler);
  }

  /**
   * Helper to format the duplicate warning panel if duplicate found.
   */
  function renderDuplicateWarning(duplicateRes) {
    if (duplicateRes && duplicateRes.is_duplicate) {
      const existing = duplicateRes.existing;
      let info = 'Already applied to this company/role!';
      if (existing && existing.applied_at) {
        const date = new Date(existing.applied_at).toLocaleDateString();
        info = `Warning: Already applied to this role on ${date} (Status: ${existing.status})`;
      }
      return `
        <div class="autoapply-duplicate-warning">
          <span>⚠️</span>
          <span>${UTILS.escapeHTML(info)}</span>
        </div>
      `;
    }
    return '';
  }

  /**
   * Helper to format the fit score analysis section.
   */
  function renderFitScoreSection() {
    if (!jobAnalysis) {
      if (!jdText) return '';
      return `
        <div class="autoapply-fit-section" style="text-align: center; padding: 12px 16px;">
          <button class="autoapply-btn autoapply-btn-secondary autoapply-analyze-btn" style="width: 100%;">Analyze Job Fit (AI)</button>
        </div>
      `;
    }

    const score = jobAnalysis.score ?? 0;
    const verdict = jobAnalysis.verdict || 'No verdict';
    const matched = jobAnalysis.matched_skills || [];
    const missing = jobAnalysis.missing_skills || [];

    return `
      <div class="autoapply-fit-section">
        <div class="autoapply-fit-header">
          <div class="autoapply-fit-score">${score}/100</div>
          <div class="autoapply-fit-verdict">
            <strong>${UTILS.escapeHTML(jobAnalysis.recommendation?.toUpperCase() || 'APPLY')}</strong> — ${UTILS.escapeHTML(verdict)}
          </div>
        </div>
        <div class="autoapply-fit-skills">
          ${matched.slice(0, 5).map(skill => `<span class="autoapply-skill-tag matched">✓ ${UTILS.escapeHTML(skill)}</span>`).join('')}
          ${missing.slice(0, 5).map(skill => `<span class="autoapply-skill-tag missing">✗ ${UTILS.escapeHTML(skill)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  /**
   * Render a single row in the review fields list.
   */
  function renderFieldRow(field, idx) {
    const inst = currentInstructions.find(i => i.field_id === field.id) || {
      field_id: field.id,
      action: 'skip',
      value: '',
      confidence: 'skip'
    };

    let displayValue = inst.value || '';
    if (inst.action === 'skip') {
      displayValue = inst.reason || 'Skipped';
    } else if (field.type === 'password') {
      displayValue = '••••••••';
    }

    const dotClass = `autoapply-confidence-dot ${inst.confidence || 'medium'}`;
    const isExpandable = displayValue.length > 100 && inst.action !== 'skip';
    const valClass = `autoapply-field-value ${inst.action === 'skip' ? 'skip' : ''}${isExpandable ? ' expandable' : ''}`;
    const toggleHtml = isExpandable ? `<button class="autoapply-expand-toggle" data-idx="${idx}">▼ more</button>` : '';

    const labelLower = (field.label || field.placeholder || field.name || '').toLowerCase();
    const isCoverLetter = (field.type === 'textarea' || field.type === 'text') && (
      labelLower.includes('cover letter') || labelLower.includes('cover_letter') 
      || labelLower.includes('coverletter') || labelLower.includes('letter of interest')
    );

    const coverLetterBtnHtml = isCoverLetter ? `
      <div style="margin-top: 6px;">
        <button class="autoapply-btn autoapply-gen-cover-btn" data-idx="${idx}" style="font-size: 11px; padding: 4px 8px; width: auto; background: linear-gradient(135deg, #667eea, #764ba2); height: auto; border: none; border-radius: 4px; color: #fff; cursor: pointer;">
          ✍ Generate Cover Letter
        </button>
      </div>
    ` : '';

    return `
      <div class="autoapply-field-row" id="row_${idx}">
        <div class="${dotClass}" title="Confidence: ${inst.confidence || 'unknown'}"></div>
        <div class="autoapply-field-info">
          <div class="autoapply-field-label">${UTILS.escapeHTML(field.label || field.placeholder || field.name || 'Unnamed Field')} ${field.required ? '<span style="color:#f87171">*</span>' : ''}</div>
          <div class="${valClass}" id="val_${idx}">${UTILS.escapeHTML(displayValue)}</div>
          ${toggleHtml}
          ${coverLetterBtnHtml}
        </div>
        <button class="autoapply-edit-btn" data-idx="${idx}" title="Edit Value">✎</button>
      </div>
    `;
  }

  // Removed duplicate setupDrag() definition

  /**
   * Switch a field row into editing mode with an input/select.
   */
  function startEditingField(idx) {
    const row = overlayContainer.querySelector(`#row_${idx}`);
    const valDiv = overlayContainer.querySelector(`#val_${idx}`);
    if (!row || !valDiv) return;

    const field = pageFields[idx];
    if (!field) return;

    const fieldId = field.id;
    const inst = currentInstructions.find(i => i.field_id === fieldId) || {
      field_id: fieldId,
      action: 'fill',
      value: '',
      confidence: 'medium'
    };

    let inputHtml = '';

    if (field.type === 'select' && field.options && field.options.length > 0) {
      inputHtml = `
        <select class="autoapply-field-input" id="input_${idx}">
          <option value="">-- Select Option --</option>
          ${field.options.map(opt => `
            <option value="${UTILS.escapeHTML(opt)}" ${opt.toLowerCase().trim() === (inst.value || '').toLowerCase().trim() ? 'selected' : ''}>
              ${UTILS.escapeHTML(opt)}
            </option>
          `).join('')}
        </select>
      `;
    } else if (field.type === 'textarea' || (inst.value && inst.value.length > 40)) {
      inputHtml = `
        <textarea class="autoapply-field-input" id="input_${idx}" rows="3">${UTILS.escapeHTML(inst.value || '')}</textarea>
      `;
    } else {
      inputHtml = `
        <input type="text" class="autoapply-field-input" id="input_${idx}" value="${UTILS.escapeHTML(inst.value || '')}">
      `;
    }

    // Remove expand toggle if present (editing replaces the value area)
    const toggle = row.querySelector('.autoapply-expand-toggle');
    if (toggle) toggle.remove();

    // Remove expandable styling during edit
    valDiv.classList.remove('expandable', 'expanded');

    // Replace the static text with the input and action buttons
    valDiv.innerHTML = `
      <div style="display: flex; gap: 4px; margin-top: 4px;">
        ${inputHtml}
        <button class="autoapply-header-btn autoapply-save-btn" data-idx="${idx}" style="align-self: flex-start; padding: 6px 10px;">✓</button>
      </div>
    `;

    // Hide edit pencil during edit
    const editBtn = row.querySelector('.autoapply-edit-btn');
    if (editBtn) editBtn.style.display = 'none';

    const input = valDiv.querySelector('.autoapply-field-input');
    const saveBtn = valDiv.querySelector('.autoapply-save-btn');

    // Focus input
    input.focus();

    // Save helper
    const save = () => {
      const newValue = input.value;
      saveFieldEdit(idx, newValue);
    };

    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      save();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && field.type !== 'textarea') {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        // Cancel, revert UI
        renderMainUI();
      }
    });
  }

  /**
   * Save the edited value, log correction to backend if changed, and update local state.
   */
  function saveFieldEdit(idx, newValue) {
    const field = pageFields[idx];
    if (!field) return;
    const fieldId = field.id;
    let inst = currentInstructions.find(i => i.field_id === fieldId);

    if (!inst) {
      inst = {
        field_id: fieldId,
        action: field.type === 'select' ? 'select' : 'fill',
        value: '',
        confidence: 'high'
      };
      currentInstructions.push(inst);
    }

    const oldValue = originalInstructionsMap.get(fieldId) || '';

    // Update value & bump confidence since it is verified/edited by the user
    inst.value = newValue;
    inst.action = newValue ? (field.type === 'select' ? 'select' : 'fill') : 'skip';
    inst.confidence = 'high';

    // Log correction if the value actually changed from the original agent proposal
    if (newValue !== oldValue) {
      const correctionPayload = {
        field_label: field.label || field.placeholder || field.name || 'Unnamed Field',
        agent_value: oldValue,
        user_value: newValue,
        context: `${UTILS.detectPlatform(window.location.href)} form field`,
        url: window.location.href
      };

      UTILS.apiCall('/api/corrections', 'POST', correctionPayload)
        .then(res => {
          console.log('[AutoApply] Correction logged successfully:', res);
        })
        .catch(err => {
          console.error('[AutoApply] Failed to log correction:', err);
        });
    }

    // Refresh UI to display updated value
    renderMainUI();
  }

  /**
   * Run the AutoPilot loop: scrape, get backend instructions, fill, advance, detect page change, and repeat.
   */
  async function runAutoPilot() {
    autopilotActive = true;
    autopilotStep = 0;
    
    const loop = async () => {
      if (!autopilotActive) return;
      autopilotStep++;
      
      if (autopilotStep > MAX_AUTOPILOT_STEPS) {
        stopAutoPilot('Stopped: exceeded maximum steps (possible loop)');
        return;
      }
      
      showAutoPilotStatus(`Filling page ${autopilotStep}...`);
      
      // 1. Scrape the current page
      try {
        const scrapeResult = SCRAPER.scrapeFormFields();
        pageFields = scrapeResult.fields;
        jdText = scrapeResult.job_description || jdText;
      } catch (err) {
        stopAutoPilot(`Scraper error: ${err.message}`);
        return;
      }
      
      if (pageFields.length === 0) {
        // No fields found - might be a confirmation or loading page
        // Wait a bit and check if it's the last page
        await new Promise(r => setTimeout(r, 1000));
        const lastCheck = FILLER.isLastPage();
        if (lastCheck.isLast) {
          stopAutoPilot('AutoPilot complete. Review and submit manually.');
          logApplicationToHistory();
          return;
        }
      }
      
      // 2. Get fill instructions from backend
      const url = window.location.href;
      const title = document.title;
      const platform = UTILS.detectPlatform(url);
      companyName = UTILS.extractCompany(url, title);
      roleName = title.split(/ - | at | \| /i)[0]
        .replace(/Apply for|Job Application for|Opening for/i, '').trim();
      
      const formSchema = {
        url, platform, page_title: title,
        step: autopilotStep, total_steps: 1,
        fields: pageFields, job_description: jdText
      };
      
      try {
        const autofillRes = await UTILS.apiCall('/api/autofill', 'POST', formSchema);
        currentInstructions = autofillRes.instructions || [];
      } catch (err) {
        stopAutoPilot(`Backend error: ${err.message}`);
        return;
      }
      
      if (!autopilotActive) return; // User clicked stop during API call
      
      // 3. Fill all fields
      const result = await FILLER.fillAllFields(currentInstructions);
      showAutoPilotStatus(
        `Page ${autopilotStep}: Filled ${result.filled}, skipped ${result.skipped}`
      );
      
      // 4. Wait for React/Angular to settle
      await new Promise(r => setTimeout(r, 800));
      
      // 5. Check if this is the last page
      const lastPageInfo = FILLER.isLastPage();
      if (lastPageInfo.isLast) {
        autopilotActive = false;
        showAutoPilotStatus(`AutoPilot complete (${lastPageInfo.reason}). Review and submit manually.`);
        logApplicationToHistory();
        // Re-render the full UI so user can review final page
        renderMainUI();
        return;
      }
      
      // 6. Click next and wait for page change
      const clicked = FILLER.clickNextButton();
      if (!clicked) {
        stopAutoPilot('Could not find a Next/Continue button.');
        return;
      }
      
      showAutoPilotStatus(`Advancing to page ${autopilotStep + 1}...`);
      
      // 7. Wait for DOM change (new form step)
      await new Promise((resolve) => {
        if (activeObserver) activeObserver.disconnect();
        activeObserver = FILLER.detectPageChange(() => {
          activeObserver.disconnect();
          activeObserver = null;
          resolve();
        });
        // Timeout after 10s in case DOM change isn't detected
        setTimeout(resolve, 10000);
      });
      
      if (!autopilotActive) return;
      
      // 8. Small delay then loop
      await new Promise(r => setTimeout(r, 500));
      await loop();
    };
    
    await loop();
  }

  /**
   * Stop AutoPilot and optionally show a status message.
   */
  function stopAutoPilot(message) {
    autopilotActive = false;
    if (message) showAutoPilotStatus(message);
  }

  /**
   * Display autopilot progress or final status inside the overlay.
   */
  function showAutoPilotStatus(text) {
    if (!overlayContainer) return;
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          <div class="autoapply-logo-icon">A</div>
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-autopilot-status">
        <div class="autoapply-autopilot-indicator ${autopilotActive ? 'active' : 'done'}"></div>
        <div class="autoapply-autopilot-text">${UTILS.escapeHTML(text)}</div>
      </div>
      ${autopilotActive ? `
        <div class="autoapply-footer">
          <button class="autoapply-btn autoapply-stop-btn">Stop AutoPilot</button>
        </div>
      ` : `
        <div class="autoapply-footer">
          <button class="autoapply-btn autoapply-btn-secondary autoapply-close-final-btn">Close</button>
        </div>
      `}
    `;
    
    const closeBtn = overlayContainer.querySelector('.autoapply-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => { stopAutoPilot(); removeOverlay(); });
    
    const stopBtn = overlayContainer.querySelector('.autoapply-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', () => {
      stopAutoPilot('AutoPilot stopped by user.');
      renderMainUI();
    });
    
    const closeFinalBtn = overlayContainer.querySelector('.autoapply-close-final-btn');
    if (closeFinalBtn) closeFinalBtn.addEventListener('click', removeOverlay);
  }

  /**
   * Log the successfully filled application to history.
   */
  function logApplicationToHistory() {
    const appData = {
      company: companyName || 'Unknown',
      role: roleName || 'Unknown',
      url: window.location.href,
      platform: UTILS.detectPlatform(window.location.href),
      fit_score: jobAnalysis ? jobAnalysis.score : null,
      status: 'applied',
      job_description_snippet: jdText ? jdText.slice(0, 200) : ''
    };
    UTILS.apiCall('/api/applications/', 'POST', appData).catch(err => {
      console.error('[AutoApply] Failed to log application:', err);
    });
  }

  /**
   * Request cover letter generation from the backend and update the matching field's value.
   */
  async function generateCoverLetter(idx, btn) {
    const field = pageFields[idx];
    if (!field) return;

    const originalText = btn.textContent;
    btn.textContent = 'Generating...';
    btn.disabled = true;
    showStatus('Generating cover letter...', false);

    try {
      const res = await UTILS.apiCall('/api/cover-letter', 'POST', {
        job_description: jdText,
        company: companyName,
        role: roleName
      });

      // Find and update the instruction for this field
      let inst = currentInstructions.find(i => i.field_id === field.id);
      if (!inst) {
        inst = { field_id: field.id, action: 'fill', value: '', confidence: 'high', source: 'ai' };
        currentInstructions.push(inst);
      }
      inst.value = res.cover_letter;
      inst.action = 'fill';
      inst.confidence = 'high';

      showStatus('Cover letter generated!', false);
      renderMainUI();
    } catch (err) {
      btn.textContent = originalText;
      btn.disabled = false;
      showStatus(`Cover letter failed: ${err.message}`, true);
    }
  }

  /**
   * Fill the form fields.
   * If advance is true, click the page next/continue button and set up page change detection.
   */
  async function handleFill(advance) {
    if (!FILLER) {
      console.error('[AutoApply] Filler module not found.');
      return;
    }

    // 1. Programmatically fill all inputs on the active DOM
    const result = await FILLER.fillAllFields(currentInstructions);
    showStatus(`Filled ${result.filled}, skipped ${result.skipped}, failed ${result.failed}`, result.failed > 0);

    if (advance) {
      // Small delay to ensure all async React/Angular updates settle
      await new Promise(resolve => setTimeout(resolve, 500));

      // 2. Click page continue button
      const clicked = FILLER.clickNextButton();

      if (clicked) {
        showStatus('Form filled. Moving to next page...', false);

        // 3. Monitor DOM changes to auto-scan the next steps
        if (activeObserver) activeObserver.disconnect();
        activeObserver = FILLER.detectPageChange(() => {
          activeObserver.disconnect();
          activeObserver = null;
          startScanningFlow();
        });
      } else {
        showStatus('Filled fields, but no Next/Continue button could be detected.', true);
      }
    } else {
      // Final step or user decided to fill without navigating.
      // Log the job application in history.
      const appData = {
        company: companyName || 'Unknown',
        role: roleName || 'Unknown',
        url: window.location.href,
        platform: UTILS.detectPlatform(window.location.href),
        fit_score: jobAnalysis ? jobAnalysis.score : null,
        status: 'applied',
        job_description_snippet: jdText ? jdText.slice(0, 200) : ''
      };

      UTILS.apiCall('/api/applications/', 'POST', appData)
        .then(res => {
          showStatus('Fields filled and application logged in history!', false);
        })
        .catch(err => {
          console.error('[AutoApply] Failed to log application:', err);
          showStatus('Fields filled, but failed to log application in history.', true);
        });
    }
  }

  /**
   * Show a bottom banner status message (e.g. success or warning).
   */
  function showStatus(text, isError) {
    if (!overlayContainer) return;
    
    // Remove existing status if any
    const oldStatus = overlayContainer.querySelector('.autoapply-status');
    if (oldStatus) oldStatus.remove();

    const statusDiv = document.createElement('div');
    statusDiv.className = `autoapply-status ${isError ? 'error' : ''}`;
    statusDiv.textContent = text;

    // Append above footer or at the bottom
    const footer = overlayContainer.querySelector('.autoapply-footer');
    if (footer) {
      overlayContainer.insertBefore(statusDiv, footer);
    } else {
      overlayContainer.appendChild(statusDiv);
    }

    // Auto-remove standard status messages after 5 seconds unless it's a critical error
    if (!isError) {
      setTimeout(() => {
        statusDiv.remove();
      }, 5000);
    }
  }



  // Register listeners for messages from the background script
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'START_AUTOFILL') {
      startScanningFlow();
      sendResponse({ status: 'started' });
    } else if (message.type === 'GET_STATUS') {
      sendResponse({ status: window.__autoapply_active ? 'active' : 'idle' });
    }
  });

  console.log('[AutoApply] Review Overlay module loaded successfully.');
})();
