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
  let pageChangeTimer = null; // Bounds the page-change wait so a silent observer can never hang the flow.
  let pendingPageChange = null; // Resolver of the in-flight page-change wait.
  let flowInFlight = false; // Guards against a concurrent scan; cleared when the flow settles.
  let fillInFlight = false; // Guards against a concurrent fill; cleared when the fill settles.
  let dismissedUrl = null; // URL the user explicitly closed the panel on (resets on navigation).
  let previousFocus = null; // Element focused before the panel opened, restored on close.
  let liveRegionEl = null; // Polite live region; it survives every panel re-render.
  let hostPageHidden = false; // The page behind the panel is hidden from screen readers.
  let fitAnalysisState = 'idle'; // idle | pending | ready | failed
  let fitAnalysisMessage = ''; // Plain sentence shown when no score is available.
  let fitAnalysisTimer = null; // Bounds the pending state so it cannot spin forever.
  let aiWarning = ''; // Non-fatal AI provider problem reported by the backend.
  let resolvedDuplicate = null; // { url, resolution, existingId } — the user's answer on this page.
  let lastFilledPageSignature = null; // Page signature at the last AutoPilot fill.
  let samePageFillCount = 0; // Consecutive AutoPilot fills of the same page.
  let pageFields = []; // Cached fields from scraper
  let jdText = ''; // Cached job description
  let cachedDuplicateRes = null; // Cached duplicate response
  let autopilotActive = false;
  let autopilotStep = 0;
  let autopilotState = 'idle';
  let autopilotMessage = '';
  let readyChipHost = null;
  let lastFillSnapshot = [];
  let hasFilledCurrentPage = false;
  let receiptRecorded = false;
  let preparationSummary = { ready_count: 0, review_count: 0, skipped_count: 0 };
  const THEME_KEY = 'autoapply_theme';
  const themeChoices = new Set(['system', 'light', 'dark']);
  const BRAND_MARK = `<span class="autoapply-logo-icon" aria-hidden="true"><svg viewBox="0 0 48 48" focusable="false"><path d="M7 2h26l13 13v26a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5Z" fill="#17213A" stroke="#344664" stroke-width="2"/><path d="M33 2v10a3 3 0 0 0 3 3h10Z" fill="#526CE7"/><path d="M10 11v26" stroke="#F47D68" stroke-width="4" stroke-linecap="round"/><path d="M20 14v9h12v11" fill="none" stroke="#91A4FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="20" cy="14" r="4" fill="#FFFDF8"/><circle cx="32" cy="23" r="4" fill="#526CE7" stroke="#FFFDF8" stroke-width="2"/><circle cx="32" cy="34" r="4" fill="#52BFAE"/></svg></span>`;
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  let themePreference = 'system';
  const MAX_AUTOPILOT_STEPS = 15;
  const MAX_SAME_PAGE_FILLS = 2; // Stop AutoPilot before re-filling one page a third time.
  const PAGE_CHANGE_TIMEOUT_MS = 8000; // Interactive "Fill & continue" wait.
  const AUTOPILOT_PAGE_CHANGE_TIMEOUT_MS = 10000; // AutoPilot wait between steps.
  const FRAME_SCRAPE_TIMEOUT_MS = 1500; // Deadline for an embedded frame's field list.
  const FRAME_FILL_TIMEOUT_MS = 8000; // Deadline for an embedded frame's fill reply.
  const CHIP_MOUNT_DEBOUNCE_MS = 300; // Page mutations are batched before the mount gate is re-read.
  const CHIP_MOUNT_RETRY_MS = 15000; // Bounded window for a client-rendered form to appear.
  const FIT_ANALYSIS_TIMEOUT_MS = 20000; // A pending match score becomes a retry control.
  let fieldFailures = new Map();
  // Cross-frame state. See the frame protocol on the responder and askChildFrames().
  const FRAME_TOKEN = UTILS.generateId('frame'); // One nonce per page session (see registerChildResponder).
  const FRAME_REQUESTS = new Map(); // Protocol type -> the batch of replies being awaited.
  let scanFramesByTag = new Map(); // Tag -> { tag, window, index } for the scan in progress.
  let frameFieldTags = new Set(); // Tags whose last scrape reported fields.
  let childBlockingLabels = []; // Required-but-empty labels reported by embedded frames.
  let lastFillIncludedFrames = false; // The last fill also wrote inside an embedded frame.
  let frameNote = ''; // One note per scan about an embedded form that stayed silent.
  let frameFields = []; // Child frame role: the fields this frame's own scrape reported.
  let frameClearSnapshot = []; // Child frame role: what its last fill changed.
  let chipObserver = null; // Watches a client-rendered page until the chip can mount.
  let chipRetryTimer = null; // Expires the chip watch.
  let chipMountDebounce = null; // Batches the chip watch's mount attempts.
  const FRAME_REPLY_TYPES = {
    AA_PROBE_RESULT: 'AA_PROBE',
    AA_SCRAPE_RESULT: 'AA_SCRAPE',
    AA_FILL_RESULT: 'AA_FILL',
    AA_CLEAR_RESULT: 'AA_CLEAR',
  };
  const EMBEDDED_FORM_SILENT_NOTE = 'A form inside this page did not answer, so some of its fields may be missing here.';
  // Only the top frame owns the panel, the backend call, and the orchestration;
  // every other frame answers questions about itself. window.top is readable
  // (never callable) across origins; an environment without it is treated as top.
  const IS_TOP_FRAME = !window.top || window.top === window;
  let workspace = {
    opportunityId: null,
    packetId: null,
    resumeVersions: [],
    selectedResumeVersionId: null,
    policy: null,
  };

  function resolvedTheme() {
    return themePreference === 'system' ? (colorScheme.matches ? 'dark' : 'light') : themePreference;
  }

  function applyOverlayTheme() {
    if (overlayContainer) overlayContainer.dataset.theme = resolvedTheme();
  }

  async function initializeTheme() {
    const saved = await browser.storage.local.get(THEME_KEY);
    themePreference = themeChoices.has(saved[THEME_KEY]) ? saved[THEME_KEY] : 'system';
    applyOverlayTheme();
  }

  function opportunityPayload() {
    return {
      url: window.location.href,
      company: companyName || 'Unknown',
      role: roleName || 'Unknown',
      platform: UTILS.detectPlatform(window.location.href),
      page_title: document.title,
      job_description_snippet: jdText ? jdText.slice(0, 3000) : '',
      job_description: jdText || '',
      source: 'browser_extension',
    };
  }

  function workspaceId(response, key) {
    return response?.[key]?.id || response?.[`${key}_id`] || response?.id || null;
  }

  async function loadWorkspaceContext({ duplicateResolution = '', existingId = null } = {}) {
    const payload = opportunityPayload();
    if (!duplicateResolution && workspace.opportunityId) {
      duplicateResolution = 'reuse';
      existingId = workspace.opportunityId;
    } else if (!duplicateResolution && resolvedDuplicate?.url === payload.url) {
      duplicateResolution = resolvedDuplicate.resolution;
      existingId = resolvedDuplicate.existingId || null;
    }
    if (duplicateResolution) resolvedDuplicate = { url: payload.url, resolution: duplicateResolution, existingId };
    const policyQuery = `?url=${encodeURIComponent(payload.url)}&platform=${encodeURIComponent(payload.platform)}`;
    const duplicateQuery = `?url=${encodeURIComponent(payload.url)}&company=${encodeURIComponent(payload.company)}&role=${encodeURIComponent(payload.role)}`;
    const [versions, policy, duplicates] = await Promise.allSettled([
      UTILS.workspaceCall('/resume-versions'),
      UTILS.workspaceCall(`/policy${policyQuery}`),
      UTILS.workspaceCall(`/duplicates${duplicateQuery}`),
    ]);

    if (versions.status === 'fulfilled') {
      workspace.resumeVersions = versions.value?.versions || versions.value?.items || [];
      const active = workspace.resumeVersions.find((version) => version.active);
      if (!workspace.selectedResumeVersionId) {
        workspace.selectedResumeVersionId = active?.id || workspace.resumeVersions[0]?.id || null;
      }
    }
    if (policy.status === 'fulfilled') {
      workspace.policy = policy.value?.policy || policy.value || null;
    }
    const matches = duplicates.status === 'fulfilled' ? (duplicates.value?.matches || []) : [];
    if (matches.length && !duplicateResolution) return { duplicates: matches };
    let opportunity = null;
    try {
      opportunity = await UTILS.workspaceCall('/opportunities/upsert', 'POST', {
        ...payload,
        status: 'preparing',
        duplicate_resolution: duplicateResolution || 'create_new',
        existing_id: existingId,
      });
    } catch (error) {
      // Bookkeeping only: a failed upsert must never stop ordinary autofill.
      console.warn('[AutoApply] Workspace context unavailable:', error);
      // A recorded track that no longer exists must be chosen again; transient
      // failures keep the user's answer and simply retry on the next scan.
      if (error?.status === 404) resolvedDuplicate = null;
    }
    if (opportunity) {
      const nextOpportunityId = workspaceId(opportunity, 'opportunity');
      if (workspace.opportunityId && workspace.opportunityId !== nextOpportunityId) workspace.packetId = null;
      workspace.opportunityId = nextOpportunityId;
    }
    // The duplicate question was already answered (or none was asked): reporting the
    // matches here would make every later scan re-prompt the user mid-flow.
    return { duplicates: [], opportunity };
  }

  /** Page text as the scraper/filler cached it; force=true takes a fresh reading. */
  function pageText(force = false) {
    return FILLER.bodyText(force) || '';
  }

  /** Employer-declared step progress, e.g. "Step 2 of 5". Null when the page states none. */
  function declaredPageStep(force = false) {
    const match = pageText(force).match(/step\s+(\d+)\s+of\s+(\d+)/i);
    if (!match) return null;
    return { step: Number(match[1]), total_steps: Number(match[2]) };
  }

  /**
   * Identity of the page's fillable controls plus its step text. A real step change
   * moves this; URL equality cannot, because SPA steps routinely keep the same URL.
   */
  function pageSignature() {
    const identity = [];
    document.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach((element) => {
      identity.push(`${element.tagName}:${element.getAttribute('type') || ''}:${element.getAttribute('name') || ''}:${element.id || ''}`);
    });
    const declared = declaredPageStep(true);
    return `${declared ? `${declared.step}/${declared.total_steps}` : ''}|${identity.join(',')}`;
  }

  /**
   * Wait for the employer page to advance. Resolves true only when the field
   * signature really changed, and always settles within timeoutMs, so a mutation
   * observer that never fires can never leave the flow hanging.
   */
  function waitForPageChange(timeoutMs) {
    if (pendingPageChange) pendingPageChange(false);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (changed) => {
        if (settled) return;
        settled = true;
        if (pageChangeTimer) {
          clearTimeout(pageChangeTimer);
          pageChangeTimer = null;
        }
        if (activeObserver) {
          activeObserver.cancel();
          activeObserver = null;
        }
        if (pendingPageChange === settle) pendingPageChange = null;
        resolve(changed);
      };
      pendingPageChange = settle;
      const before = pageSignature();
      if (activeObserver) {
        activeObserver.cancel();
        activeObserver = null;
      }
      activeObserver = FILLER.detectPageChange(() => {
        if (pageSignature() === before) return; // An unrelated mutation, not a new step.
        settle(true);
      });
      pageChangeTimer = setTimeout(() => settle(false), timeoutMs);
    });
  }

  function fieldElement(field) {
    return document.getElementById(field.id) || document.querySelector(`[data-autoapply-id="${CSS.escape(field.id)}"]`);
  }

  function fieldLabel(field) {
    return field.label || field.placeholder || field.name || field.id;
  }

  /** Rendered check matching the filler's isRenderedControl, so both agree on "still blank". */
  function isRenderedElement(element) {
    if (!element || element.hidden) return false;
    if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) return false;
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : null;
    return !style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0');
  }

  // --- Focus and announcements ------------------------------------------------
  //
  // The panel is a modal review: the keyboard stays inside it and the page
  // behind it is hidden from screen readers while it is open. Both are undone
  // the moment the panel closes, and whatever the page had before is restored.

  /** The panel's own controls, in tab order. */
  function panelFocusables() {
    if (!overlayContainer) return [];
    return [...overlayContainer.querySelectorAll('button:not([disabled]), a[href], input, select, textarea, summary')]
      .filter((element) => isRenderedElement(element));
  }

  /** Wrap Tab and Shift+Tab around the panel instead of letting focus escape. */
  function trapPanelFocus(event) {
    if (!overlayContainer) return;
    const focusable = panelFocusables();
    const active = (shadowRoot && shadowRoot.activeElement) || document.activeElement;
    if (!overlayContainer.contains(active)) {
      event.preventDefault();
      const target = focusable.length
        ? (event.shiftKey ? focusable[focusable.length - 1] : focusable[0])
        : overlayContainer;
      target.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  /** Hide the employer page from assistive tech while the panel owns the screen. */
  function setHostPageHidden(hidden) {
    if (!document.body || hostPageHidden === hidden) return;
    hostPageHidden = hidden;
    for (const child of document.body.children) {
      if (child.nodeType !== 1 || child === shadowHost || child === readyChipHost) continue;
      if (hidden) {
        if (!child.hasAttribute('data-autoapply-hidden')) {
          child.setAttribute('data-autoapply-hidden', child.getAttribute('aria-hidden') || '');
        }
        child.setAttribute('aria-hidden', 'true');
      } else if (child.hasAttribute('data-autoapply-hidden')) {
        const previous = child.getAttribute('data-autoapply-hidden');
        child.removeAttribute('data-autoapply-hidden');
        if (previous) child.setAttribute('aria-hidden', previous);
        else child.removeAttribute('aria-hidden');
      }
    }
  }

  /**
   * Say something in the panel's polite live region: loading text, status
   * banners and Auto-run progress are read out instead of only appearing.
   * The region is emptied first so a repeated sentence is announced again.
   */
  function announce(text) {
    if (!liveRegionEl) return;
    liveRegionEl.textContent = '';
    setTimeout(() => {
      if (liveRegionEl) liveRegionEl.textContent = String(text || '');
    }, 30);
  }

  /** Human labels for fill attempts that failed, resolved through the scraped field list. */
  function failedFieldLabels(failures) {
    return (failures || []).map((failure) => {
      const field = pageFields.find((candidate) => candidate.id === failure.field_id);
      return field ? fieldLabel(field) : failure.field_id;
    });
  }

  /**
   * Names of the required fields still empty in `fields`. The top frame passes
   * its merged page fields; a child frame passes the fields it owns, so it can
   * report what it is still blocking on.
   */
  function unfilledRequiredFields(fields = pageFields) {
    const missing = [];
    for (const field of fields) {
      if (!field.required) continue;
      const element = fieldElement(field);
      if (!isRenderedElement(element)) continue;
      if (field.type === 'file') {
        if (!element.files?.length) missing.push(fieldLabel(field));
      } else if (field.type === 'radio' || field.type === 'checkbox') {
        const group = element.name
          ? [...document.querySelectorAll(`input[type="${field.type}"][name="${CSS.escape(element.name)}"]`)]
          : [];
        if (!(group.length ? group : [element]).some((input) => input.checked)) missing.push(fieldLabel(field));
      } else if (!String(element.value ?? '').trim()) {
        missing.push(fieldLabel(field));
      }
    }
    return missing;
  }

  /**
   * Everything still blocking advancement: the required fields of this document
   * plus the ones the embedded frames reported as empty.
   */
  function blockingRequiredFields() {
    return unfilledRequiredFields().concat(childBlockingLabels);
  }

  // --- Embedded frames -------------------------------------------------------
  //
  // Every frame receives the content scripts, so a form rendered inside an
  // iframe (SmartRecruiters one-click apply) is invisible to the top document
  // alone. The top frame owns the panel, the backend call, and the review; a
  // child frame only answers questions about itself, over the frame protocol:
  //
  //   top -> child   { __autoapply, token, type: AA_PROBE|AA_SCRAPE|AA_FILL|AA_CLEAR, frameTag, instructions?, timeoutMs? }
  //   child -> parent{ __autoapply, token, type: <type>_RESULT, frameTag, ok, fields?, job_description?, results?, blocking? }
  //
  // A child accepts a message only from its own parent and locks onto the first
  // token it sees; a reply is accepted only from a window the top frame actually
  // messaged, with this page session's token.

  /** Direct child browsing contexts, tagged f1..fn in window.frames order. */
  function childWindows() {
    const list = [];
    const frames = window.frames;
    if (!frames || typeof frames.length !== 'number') return list;
    for (let index = 0; index < frames.length; index += 1) {
      if (frames[index]) list.push({ tag: `f${index + 1}`, window: frames[index], index });
    }
    return list;
  }

  /** The <iframe> behind a child frame, for judging whether it can hold a form. */
  function frameElementFor(frame) {
    try {
      if (frame.window.frameElement) return frame.window.frameElement;
    } catch (_) {
      // A cross-origin frame does not expose its container; fall back to order.
    }
    return document.querySelectorAll('iframe, frame')[frame.index] || null;
  }

  /** A rendered frame box big enough to hold a form; a 1x1 tracker is not one. */
  function isPlausibleFormBox(element) {
    if (!element || !FILLER.isRenderedControl(element)) return false;
    if (typeof element.getBoundingClientRect !== 'function') return false;
    const box = element.getBoundingClientRect();
    return box.width >= 120 && box.height >= 80;
  }

  /**
   * Only a frame occupying a real, rendered box can be an embedded form. A 1x1
   * tracking frame that never answers is not one and must not raise a note.
   */
  function isPlausibleFormFrame(frame) {
    return isPlausibleFormBox(frameElementFor(frame));
  }

  /**
   * Post one message to each requested child window and collect the replies that
   * arrive before the deadline. The batch always settles: a frame that never
   * answers is reported as missing instead of being awaited forever, and each
   * frame is messaged exactly once per call.
   * @returns {Promise<{ replies: Map<string, object>, missing: string[] }>}
   */
  function askChildFrames(type, requests, timeoutMs) {
    return new Promise((resolve) => {
      const superseded = FRAME_REQUESTS.get(type);
      if (superseded) superseded.settle(); // A stuck earlier batch must not leak into this one.
      const unreachable = [];
      const entry = {
        expected: new Set(requests.map(({ frame }) => frame.tag)),
        replies: new Map(),
        timer: null,
        settled: false,
        settle() {
          if (entry.settled) return;
          entry.settled = true;
          clearTimeout(entry.timer);
          if (FRAME_REQUESTS.get(type) === entry) FRAME_REQUESTS.delete(type);
          resolve({ replies: entry.replies, missing: [...entry.expected, ...unreachable] });
        },
      };
      FRAME_REQUESTS.set(type, entry);
      for (const { frame, payload } of requests) {
        try {
          if (frame.window.closed) throw new Error('the frame is gone');
          frame.window.postMessage({ __autoapply: true, token: FRAME_TOKEN, type, frameTag: frame.tag, timeoutMs, ...(payload || {}) }, '*');
        } catch (error) {
          console.warn(`[AutoApply] Could not reach embedded frame ${frame.tag}:`, error);
          entry.expected.delete(frame.tag);
          unreachable.push(frame.tag);
        }
      }
      if (!entry.expected.size) {
        entry.settle();
        return;
      }
      entry.timer = setTimeout(() => entry.settle(), timeoutMs);
    });
  }

  /** Register the top frame's side of the frame protocol. */
  function watchFrameReplies() {
    window.addEventListener('message', (event) => {
      const data = event.data;
      if (!data || data.__autoapply !== true || data.token !== FRAME_TOKEN) return;
      const pending = FRAME_REQUESTS.get(FRAME_REPLY_TYPES[data.type]);
      if (!pending) return; // A late reply, or one from a frame nobody asked.
      if (scanFramesByTag.get(data.frameTag)?.window !== event.source) return; // Only windows we messaged.
      pending.expected.delete(data.frameTag);
      pending.replies.set(data.frameTag, data);
      if (!pending.expected.size) pending.settle();
    });
  }

  /**
   * Surface a silent frame once, and only while it looks like an embedded form:
   * tracking frames that never answer are normal on real pages.
   */
  function reportSilentFrames(tags) {
    if (frameNote || !tags.length) return;
    const plausible = tags.some((tag) => {
      const frame = scanFramesByTag.get(tag);
      return frame ? isPlausibleFormFrame(frame) : false;
    });
    if (plausible) frameNote = EMBEDDED_FORM_SILENT_NOTE;
  }

  /**
   * Ask every direct child frame for the fields it owns and merge them under
   * `fN:` ids. A frame with no fields is ignored entirely; a silent frame that
   * looks like a form is surfaced once in the panel.
   */
  async function collectChildFrames() {
    const frames = childWindows();
    scanFramesByTag = new Map(frames.map((frame) => [frame.tag, frame]));
    frameFieldTags = new Set();
    childBlockingLabels = []; // A new scan invalidates the previous step's answers.
    frameNote = '';
    if (!frames.length) return { fields: [], job_description: '' };
    const { replies, missing } = await askChildFrames(
      'AA_SCRAPE',
      frames.map((frame) => ({ frame, payload: {} })),
      FRAME_SCRAPE_TIMEOUT_MS,
    );
    const fields = [];
    let jobDescription = '';
    for (const frame of frames) {
      const reply = replies.get(frame.tag);
      const own = Array.isArray(reply?.fields) ? reply.fields : [];
      if (!own.length) continue;
      frameFieldTags.add(frame.tag);
      for (const field of own) fields.push({ ...field, id: `${frame.tag}:${field.id}`, frameTag: frame.tag });
      if (!jobDescription && reply.job_description) jobDescription = reply.job_description;
    }
    reportSilentFrames(missing);
    return { fields, job_description: jobDescription };
  }

  /**
   * Split instructions by owner: this document, or the embedded frame whose tag
   * prefixes the id. An id is only treated as a frame id when the prefix is a
   * frame that really reported fields, so a local id can never be stolen.
   */
  function splitInstructions(instructions) {
    const mine = [];
    const byFrame = new Map();
    for (const instruction of instructions) {
      const id = String(instruction?.field_id || '');
      const separator = id.indexOf(':');
      const tag = separator === -1 ? '' : id.slice(0, separator);
      if (!tag || !frameFieldTags.has(tag)) {
        mine.push(instruction);
        continue;
      }
      if (!byFrame.has(tag)) byFrame.set(tag, []);
      byFrame.get(tag).push({ ...instruction, field_id: id.slice(separator + 1) });
    }
    return { mine, byFrame };
  }

  /**
   * Route each embedded frame's instructions back to it, and merge its answer
   * into the page-level result. The child reports local field ids and labels, so
   * failures are namespaced again here to match the review rows.
   */
  async function fillChildFrames(byFrame) {
    childBlockingLabels = [];
    lastFillIncludedFrames = false;
    const merged = { filled: 0, skipped: 0, failed: 0, failures: [] };
    const requests = [];
    for (const [tag, instructions] of byFrame) {
      const frame = scanFramesByTag.get(tag);
      if (frame) requests.push({ frame, payload: { instructions } });
    }
    if (!requests.length) return merged;
    // The frames hold their own copy of what this fill changes, so undo has to
    // reach them even when the reply is late.
    lastFillIncludedFrames = true;
    const { replies, missing } = await askChildFrames('AA_FILL', requests, FRAME_FILL_TIMEOUT_MS);
    for (const { frame } of requests) {
      const reply = replies.get(frame.tag);
      if (!reply) continue;
      const results = reply.results || {};
      merged.filled += results.filled || 0;
      merged.skipped += results.skipped || 0;
      merged.failed += results.failed || 0;
      for (const failure of results.failures || []) {
        merged.failures.push({ ...failure, field_id: `${frame.tag}:${failure.field_id}` });
      }
      if (Array.isArray(reply.blocking)) childBlockingLabels.push(...reply.blocking);
    }
    reportSilentFrames(missing);
    return merged;
  }

  /** Ask the frames that own fields to put back what the last fill changed. */
  async function clearChildFrames() {
    const frames = [...frameFieldTags].map((tag) => scanFramesByTag.get(tag)).filter(Boolean);
    if (!frames.length) return;
    await askChildFrames('AA_CLEAR', frames.map((frame) => ({ frame, payload: {} })), FRAME_FILL_TIMEOUT_MS);
  }

  /**
   * Child frame role: answer the top frame's questions about this document. No
   * panel, no chip, no scan, and no backend call happens in a child frame.
   */
  function registerChildResponder() {
    let acceptedToken = null; // The first token this frame saw; later mismatches are ignored.
    window.addEventListener('message', async (event) => {
      const data = event.data;
      if (!data || data.__autoapply !== true) return;
      if (event.source !== window.parent) return; // Only this frame's parent may ask.
      if (acceptedToken === null) acceptedToken = data.token;
      else if (data.token !== acceptedToken) return;
      const frameTag = data.frameTag || null;
      const reply = (payload) => {
        try {
          event.source.postMessage({ __autoapply: true, token: acceptedToken, frameTag, ...payload }, '*');
        } catch (error) {
          console.warn('[AutoApply] Could not answer the top frame:', error);
        }
      };
      if (data.type === 'AA_PROBE' || data.type === 'AA_SCRAPE') {
        const scrape = SCRAPER.scrapeFormFields();
        frameFields = scrape.fields;
        reply({
          type: data.type === 'AA_PROBE' ? 'AA_PROBE_RESULT' : 'AA_SCRAPE_RESULT',
          ok: true,
          fields: frameFields,
          job_description: scrape.job_description,
        });
        return;
      }
      if (data.type === 'AA_FILL') {
        // Only ids this frame scraped and stamped may be touched: a message can
        // never make a frame fill a control that was not in its own schema.
        const known = new Set(frameFields.map((field) => field.id));
        const instructions = (Array.isArray(data.instructions) ? data.instructions : [])
          .filter((instruction) => known.has(instruction?.field_id));
        frameClearSnapshot = captureFillSnapshot(instructions, frameFields);
        const results = await FILLER.fillAllFields(instructions);
        reply({ type: 'AA_FILL_RESULT', ok: true, results, blocking: unfilledRequiredFields(frameFields) });
        return;
      }
      if (data.type === 'AA_CLEAR') {
        restoreFillSnapshot(frameClearSnapshot);
        frameClearSnapshot = [];
        reply({ type: 'AA_CLEAR_RESULT', ok: true });
      }
    });
  }

  /** The values a fill is about to change, so the change can be undone again. */
  function captureFillSnapshot(instructions, fields = pageFields) {
    return instructions.map((instruction) => {
      const field = fields.find((candidate) => candidate.id === instruction.field_id);
      const element = field ? fieldElement(field) : null;
      if (!field || !element || field.type === 'file' || instruction.action === 'skip') return null;
      return {
        element,
        type: field.type,
        value: element.hasAttribute?.('contenteditable') ? element.textContent : element.value,
        checked: Boolean(element.checked),
      };
    }).filter(Boolean);
  }

  /** Put back the values captured before a fill. */
  function restoreFillSnapshot(snapshot) {
    for (const entry of snapshot) {
      const { element } = entry;
      if (!element?.isConnected) continue;
      if (entry.type === 'checkbox' || entry.type === 'radio') element.checked = entry.checked;
      else if (element.hasAttribute?.('contenteditable')) element.textContent = entry.value || '';
      else element.value = entry.value || '';
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /**
   * The backend's own explanation of a failure. `apiCall()` carries it as
   * `error.detail`; an older shape nested the same text in the message body.
   */
  function apiErrorDetail(error) {
    const declared = typeof error?.detail === 'string' ? error.detail.trim() : '';
    if (declared) return declared;
    const raw = String(error?.message || error || '').trim();
    const jsonStart = raw.indexOf('{');
    if (jsonStart !== -1) {
      try {
        const body = JSON.parse(raw.slice(jsonStart));
        const detail = body?.detail ?? body?.ai_error;
        if (typeof detail === 'string' && detail.trim()) return detail.trim();
      } catch (_) {
        // Not a JSON error body; fall through to the raw message.
      }
    }
    return raw;
  }

  /**
   * What to tell someone about a failure the backend described in its own
   * words. The detail is classified, never printed: it can name a provider,
   * a setting or a status code, none of which belongs in front of a job seeker.
   */
  function plainFailureReason(detail) {
    const text = String(detail || '');
    if (/api key|not configured|provider|unauthor|invalid key/i.test(text)) return 'Finish setup in AutoApply, then try again.';
    if (/rate.?limit|quota|too many/i.test(text)) return 'The AI service is busy right now. Try again in a minute.';
    if (/timeout|timed out|took too long|slow/i.test(text)) return 'The AI service is taking too long. Try again in a minute.';
    if (/no longer exists|not found/i.test(text)) return 'That saved application is gone. Reload the page and try again.';
    return 'Please try again.';
  }

  /**
   * Backend prose, said in this product's words. Only wording is rewritten;
   * identifiers, stored values and URLs are never touched.
   */
  function plainPhrase(text) {
    return String(text || '')
      .replace(/\bautofill polic(?:y|ies)\b/gi, 'your fill rules')
      .replace(/\bpolic(?:y|ies)\b/gi, 'fill rules');
  }

  /**
   * Turn a failure into actionable copy. `apiCall()` classifies an HTTP
   * failure on the error itself (`status`, `detail`), so neither a status code
   * nor the backend's own vocabulary can reach the panel.
   */
  function preparationErrorMessage(error) {
    const detail = apiErrorDetail(error);
    if (error?.status === 404) return 'Finish setup in AutoApply before preparing this page.';
    if (/failed to fetch|networkerror|load failed/i.test(String(error?.message || ''))) {
      return 'Can’t reach AutoApply. Start AutoApply, then try again.';
    }
    if ([429, 502, 503].includes(error?.status)) {
      return 'AI suggestions are off right now. Your saved details still fill in.';
    }
    return `AutoApply couldn’t prepare this page. ${plainFailureReason(detail)}`;
  }

  function policyBlocksAutopilot() {
    return workspace.policy && workspace.policy.allow_autopilot === false;
  }

  function policyMessage() {
    if (!workspace.policy) return '';
    return workspace.policy.message || workspace.policy.reason || '';
  }

  function renderWorkspaceContext() {
    const policyText = policyMessage();
    const versions = workspace.resumeVersions || [];
    const versionSelect = versions.length
      ? `<label style="display:block;font-size:11px;margin-top:8px;">Resume version
          <select class="autoapply-resume-version" style="width:100%;margin-top:3px;">
            ${versions.map((version) => `<option value="${UTILS.escapeHTML(version.id)}" ${version.id === workspace.selectedResumeVersionId ? 'selected' : ''}>${UTILS.escapeHTML(version.label || version.filename || version.id)}</option>`).join('')}
          </select>
        </label>`
      : '<div style="font-size:11px;margin-top:6px;">No resume version is saved in AutoApply yet, so file fields stay manual.</div>';
    return `
      <div class="autoapply-workspace-context">
        <div class="autoapply-context-label">Resume for this application</div>
        ${versionSelect}
        ${policyText ? `<div style="font-size:11px;margin-top:6px;color:#f5c451;">Fill rules: ${UTILS.escapeHTML(plainPhrase(policyText))}</div>` : ''}
      </div>
    `;
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function attachSelectedResume(el) {
    if (el.type !== 'file') {
      return { ok: false, reason: 'This field does not take a file.' };
    }
    if (!workspace.selectedResumeVersionId) {
      FILLER.highlightUploadField?.(el);
      return { ok: false, reason: 'Choose a saved resume in this panel, or select the file yourself.' };
    }
    try {
      const response = await browser.runtime.sendMessage({
        type: 'FETCH_RESUME_VERSION',
        version_id: workspace.selectedResumeVersionId,
      });
      if (!response || response.status !== 'success' || !response.file?.base64) {
        throw new Error('AutoApply could not read that resume file.');
      }
      if (typeof DataTransfer === 'undefined') throw new Error('This browser will not let AutoApply attach the file.');
      const file = new File(
        [base64ToBytes(response.file.base64)],
        response.file.filename || 'resume.pdf',
        { type: response.file.contentType || 'application/pdf' }
      );
      const transfer = new DataTransfer();
      transfer.items.add(file);
      el.files = transfer.files;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    } catch (error) {
      FILLER.highlightUploadField?.(el);
      return { ok: false, reason: `${plainPhrase(error?.message || 'The file could not be attached automatically.')} Select it yourself.` };
    }
  }

  async function saveWorkspacePacket(stage, fillResult = null) {
    if (!workspace.opportunityId) return null;
    try {
      const coverInstruction = currentInstructions.find((instruction) => {
        const field = pageFields.find((candidate) => candidate.id === instruction.field_id);
        return /cover[ _-]?letter/i.test(`${field?.label || ''} ${field?.name || ''}`);
      });
      const response = await UTILS.workspaceCall('/application-packets', 'POST', {
        id: workspace.packetId || undefined,
        opportunity_id: workspace.opportunityId,
        resume_version_id: workspace.selectedResumeVersionId,
        stage,
        page_url: window.location.href,
        instructions: currentInstructions,
        field_failures: fillResult?.failures || Array.from(fieldFailures.values()),
        cover_letter: coverInstruction?.value || null,
        form_snapshot: { company: companyName, role: roleName, page_title: document.title },
      });
      workspace.packetId = workspaceId(response, 'packet') || workspace.packetId;
      const opportunityStatus = ['submitted_by_user'].includes(stage) ? 'submitted' : 'ready_to_review';
      await UTILS.workspaceCall(`/opportunities/${encodeURIComponent(workspace.opportunityId)}`, 'PATCH', {
        status: opportunityStatus,
        fit_score: jobAnalysis?.score ?? undefined,
      });
      return response;
    } catch (error) {
      console.warn('[AutoApply] Workspace packet was not saved:', error);
      return null;
    }
  }

  async function captureTeach(field, originalValue, correctedValue) {
    const failure = fieldFailures.get(field.id);
    if (!workspace.opportunityId || (!failure && originalValue === correctedValue)) return;
    try {
      await UTILS.workspaceCall('/teaches', 'POST', {
        opportunity_id: workspace.opportunityId,
        packet_id: workspace.packetId,
        url: window.location.href,
        field: { id: field.id, label: field.label || field.name || '', type: field.type },
        proposed_value: originalValue,
        corrected_value: correctedValue,
        failure_reason: failure?.reason || null,
      });
      fieldFailures.delete(field.id);
    } catch (error) {
      console.warn('[AutoApply] Teach capture was not saved:', error);
    }
  }

  function submissionReceipt() {
    const match = pageText().match(/(application (?:has been )?(?:submitted|received)|thank you for applying|we received your application)/i);
    return { url: window.location.href, title: document.title, confirmation_text: match ? match[1] : '' };
  }

  async function confirmManualSubmission() {
    if (!window.confirm('Confirm that you personally clicked the employer’s Submit button. AutoApply will only save a submission record; it will not submit anything.')) return;
    await saveWorkspacePacket('submitted_by_user');
    if (!workspace.opportunityId || !workspace.packetId) {
      showStatus('Submission was not recorded because AutoApply is not reachable.', true);
      return;
    }
    try {
      const response = await UTILS.workspaceCall('/submissions/confirm', 'POST', {
        opportunity_id: workspace.opportunityId,
        packet_id: workspace.packetId,
        submitted_at: new Date().toISOString(),
        receipt: submissionReceipt(),
        user_confirmed: true,
      });
      receiptRecorded = true;
      showStatus(response?.receipt?.id ? 'Submission record saved.' : 'Manual submission saved.', false);
      renderMainUI();
    } catch (error) {
      showStatus(`Could not save the submission record. ${plainFailureReason(error?.detail)}`, true);
    }
  }

  // Drag state
  let dragOffsetX = 0, dragOffsetY = 0, isDragging = false;
  let dragMoveHandler = null;
  let dragUpHandler = null;

  /**
   * Start the scan, analysis, and fill-preparation flow.
   * Concurrent triggers are ignored; internal callers that refresh a displayed
   * panel after a real page change pass `force`.
   */
  async function startScanningFlow({ force = false } = {}) {
    if (flowInFlight && !force) {
      console.log('[AutoApply] A scan is already running; ignoring the duplicate trigger.');
      return false;
    }
    flowInFlight = true;
    try {
      await runScanningFlow();
      return true;
    } finally {
      flowInFlight = false;
    }
  }

  /**
   * Scrape this document and every embedded frame, and refresh the review state
   * they feed. Embedded fields keep their `fN:` id so an instruction can always
   * be routed back to the frame that owns it.
   */
  async function scanPageFields() {
    const scrapeResult = SCRAPER.scrapeFormFields();
    const embedded = await collectChildFrames();
    pageFields = scrapeResult.fields.concat(embedded.fields);
    const description = scrapeResult.job_description || embedded.job_description;
    if (description) jdText = description;
    pageText(true); // Refresh the filler's cached page text for this scan.
    return pageFields;
  }

  async function runScanningFlow() {
    removeOverlay();
    removeReadyChip();
    window.__autoapply_active = true;
    hasFilledCurrentPage = false;
    lastFillSnapshot = [];
    lastFillIncludedFrames = false;
    aiWarning = '';

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

    // One polite live region for the whole panel: it sits beside the panel
    // element so a re-render cannot throw away what is being announced.
    liveRegionEl = document.createElement('div');
    liveRegionEl.className = 'autoapply-live-region';
    liveRegionEl.setAttribute('role', 'status');
    liveRegionEl.setAttribute('aria-live', 'polite');
    shadowRoot.appendChild(liveRegionEl);

    // Create the overlay container element inside shadow root
    overlayContainer = document.createElement('div');
    overlayContainer.className = 'autoapply-overlay';
    overlayContainer.setAttribute('role', 'dialog');
    overlayContainer.setAttribute('aria-modal', 'true');
    overlayContainer.setAttribute('aria-label', 'AutoApply application review');
    overlayContainer.tabIndex = -1;
    applyOverlayTheme();
    shadowRoot.appendChild(overlayContainer);
    previousFocus = document.activeElement;
    overlayContainer.focus({ preventScroll: true });
    document.addEventListener('keydown', handleOverlayKeydown, true);
    setHostPageHidden(true);

    showLoading('Scanning this page and preparing your review…');

    try {
      await scanPageFields();
    } catch (err) {
      console.error('[AutoApply] Scraper error:', err);
      showError('AutoApply couldn\'t read this page. Reload the page and try again.');
      return;
    }

    const url = window.location.href;
    const title = document.title;
    const platform = UTILS.detectPlatform(url);
    companyName = UTILS.extractCompany(url, title);
    roleName = UTILS.extractRole(url, title, document);

    try {
      const context = await loadWorkspaceContext();
      if (context?.duplicates?.length) {
        cachedDuplicateRes = { is_duplicate: true, existing: context.duplicates[0] };
        showDuplicateChoice(context.duplicates);
        return;
      }
      await prepareCurrentPage({ url, title, platform });
    } catch (err) {
      console.error('[AutoApply] Backend connection error:', err);
      showError(preparationErrorMessage(err));
    }
  }

  async function prepareCurrentPage({ url = window.location.href, title = document.title, platform = UTILS.detectPlatform(window.location.href), analyzeFit = true } = {}) {
    const declared = declaredPageStep();
    const formSchema = {
      url, platform, page_title: title,
      step: declared?.step || 1, total_steps: declared?.total_steps ?? null,
      fields: pageFields, job_description: jdText,
      opportunity_id: workspace.opportunityId,
      resume_version_id: workspace.selectedResumeVersionId,
    };
    const autofillRes = await UTILS.apiCall('/api/autofill', 'POST', formSchema);
    aiWarning = autofillRes.ai_error || '';
    currentInstructions = autofillRes.instructions || [];
    preparationSummary = {
      ready_count: autofillRes.ready_count || currentInstructions.filter((item) => !item.review_required).length,
      review_count: autofillRes.review_count || currentInstructions.filter((item) => item.review_required).length,
      skipped_count: autofillRes.skipped_count || currentInstructions.filter((item) => item.action === 'skip').length,
    };
    originalInstructionsMap.clear();
    currentInstructions.forEach((inst) => originalInstructionsMap.set(inst.field_id, inst.value));
    renderMainUI();
    await saveWorkspacePacket('ready_to_review');
    if (analyzeFit && jdText && jdText.length >= 100) analyzeFitProgressively();
    return autofillRes;
  }

  /**
   * Ask for a match score. It never blocks the fill flow, it is never asked
   * for twice at once, and it always settles: a slow or failed request leaves
   * a retry control in the panel instead of a spinner that never stops.
   */
  async function analyzeFitProgressively() {
    if (!jdText || jdText.length < 100) return;
    if (fitAnalysisState === 'pending') return;
    fitAnalysisState = 'pending';
    fitAnalysisMessage = '';
    clearTimeout(fitAnalysisTimer);
    fitAnalysisTimer = setTimeout(() => {
      fitAnalysisTimer = null;
      if (fitAnalysisState !== 'pending') return;
      fitAnalysisState = 'failed';
      fitAnalysisMessage = 'AutoApply could not work out a match score for this page.';
      renderReviewIfOpen();
    }, FIT_ANALYSIS_TIMEOUT_MS);
    renderReviewIfOpen();
    try {
      const analysis = await UTILS.apiCall('/api/analyze-job', 'POST', { job_description: jdText });
      if (analysis?.recommendation === 'unknown' && analysis?.score === 0) {
        fitAnalysisState = 'failed';
        fitAnalysisMessage = 'This posting does not say enough to score the match.';
      } else {
        jobAnalysis = analysis;
        fitAnalysisState = 'ready';
        if (workspace.opportunityId) {
          await UTILS.workspaceCall(`/opportunities/${encodeURIComponent(workspace.opportunityId)}`, 'PATCH', { fit_score: analysis.score });
        }
      }
    } catch (error) {
      console.warn('[AutoApply] Fit analysis is unavailable:', error);
      fitAnalysisState = 'failed';
      fitAnalysisMessage = `AutoApply could not work out a match score. ${plainFailureReason(error?.detail)}`;
    } finally {
      clearTimeout(fitAnalysisTimer);
      fitAnalysisTimer = null;
      renderReviewIfOpen();
    }
  }

  /** Re-render the review only when it is the view on screen (never mid-edit). */
  function renderReviewIfOpen() {
    if (!overlayContainer || !overlayContainer.querySelector('.autoapply-primary-action-btn')) return;
    renderMainUI();
  }

  function showDuplicateChoice(matches) {
    if (!overlayContainer) return;
    const first = matches[0];
    overlayContainer.innerHTML = `
      <div class="autoapply-header"><div class="autoapply-logo">${BRAND_MARK}<span>AutoApply</span></div><button class="autoapply-header-btn autoapply-close-btn" title="Close" aria-label="Close">✕</button></div>
      <div class="autoapply-duplicate-choice"><p class="autoapply-kicker">Already saved?</p><h2>${UTILS.escapeHTML(first.company || companyName)} · ${UTILS.escapeHTML(first.role || roleName)}</h2><p>${UTILS.escapeHTML(first.match_reason || 'This looks like an application you already saved in AutoApply.')}</p><div class="autoapply-choice-actions"><button class="autoapply-btn autoapply-btn-primary autoapply-reuse-btn">Open the saved application</button><button class="autoapply-btn autoapply-btn-secondary autoapply-new-attempt-btn">This is a different application</button></div></div>`;
    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', dismissOverlay);
    overlayContainer.querySelector('.autoapply-reuse-btn').addEventListener('click', async () => {
      showLoading('Opening the saved application…');
      try {
        const response = await browser.runtime.sendMessage({ type:'OPEN_WORKSPACE_RECORD', opportunity_id:first.id });
        if (response?.status !== 'success') throw new Error('Could not open that saved application.');
        // This flow now belongs to the tracked record; a later step must not ask again.
        workspace.opportunityId = first.id;
        workspace.packetId = null;
        resolvedDuplicate = { url: window.location.href, resolution: 'reuse', existingId: first.id };
        dismissOverlay();
      }
      catch (error) { showError(plainPhrase(error?.message) || 'AutoApply could not open that application. Try again.'); }
    });
    overlayContainer.querySelector('.autoapply-new-attempt-btn').addEventListener('click', async () => {
      showLoading('Preparing a new application…');
      try { await loadWorkspaceContext({ duplicateResolution:'create_new' }); await prepareCurrentPage(); }
      catch (error) { showError(plainPhrase(error?.message) || 'AutoApply could not prepare this page. Try again.'); }
    });
  }

  async function prepareApplicationSilently(message = {}) {
    try {
      await scanPageFields();
      const url = window.location.href;
      const title = document.title;
      const platform = UTILS.detectPlatform(url);
      companyName = UTILS.extractCompany(url, title);
      roleName = UTILS.extractRole(url, title, document);
      const context = await loadWorkspaceContext({ duplicateResolution:message.duplicate_resolution || '', existingId:message.existing_id || null });
      if (context?.duplicates?.length && !message.duplicate_resolution) {
        return { ok:true, status:'duplicate', matches:context.duplicates, title:`${roleName} · ${companyName}` };
      }
      const result = await prepareCurrentPage({ url, title, platform, analyzeFit:false });
      if (jdText && jdText.length >= 100) {
        try {
          const analysis = await UTILS.apiCall('/api/analyze-job', 'POST', { job_description:jdText });
          if (analysis?.recommendation !== 'unknown' && workspace.opportunityId) {
            jobAnalysis = analysis;
            await UTILS.workspaceCall(`/opportunities/${encodeURIComponent(workspace.opportunityId)}`, 'PATCH', { fit_score:analysis.score });
          }
        } catch (error) {
          // Fit is intentionally non-blocking here; the popup reports the rest.
          console.warn('[AutoApply] Fit analysis is unavailable:', error);
        }
      }
      return { ok:true, status:'ready', opportunity_id:workspace.opportunityId, reused:Boolean(context?.opportunity?.reused), title:`${roleName} · ${companyName}`, fit_score:jobAnalysis?.score, ready_count:result.ready_count, review_count:result.review_count };
    } catch (error) {
      return { ok:false, error:error?.message || 'AutoApply could not prepare this page.' };
    }
  }

  /**
   * Visible, fillable controls on the employer page. The filler's own
   * visibility predicate is used because `offsetParent` is null for a
   * fixed-position control; site chrome — a search box, a newsletter form —
   * is not an application field.
   */
  function visibleFillableControls() {
    return [...document.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter((element) => {
      if (element.type === 'search') return false;
      if (element.disabled || !FILLER.isRenderedControl(element)) return false;
      return !element.closest('nav, header, footer, [role="search"]');
    });
  }

  /** A rendered form box big enough to hold an application, outside site chrome. */
  function hasPlausibleFormContainer() {
    return [...document.querySelectorAll('form, [role="form"]')].some((form) => {
      if (form.closest('nav, header, footer, [role="search"]')) return false;
      if (!isPlausibleFormBox(form)) return false;
      return Boolean(form.querySelector('input:not([type="hidden"]), select, textarea'));
    });
  }

  /**
   * Is this page an application to prepare? The known job boards are the fast
   * path, but plenty of employers host their own forms, so a page with two
   * fillable controls — or a real form container — qualifies on its own.
   */
  function looksLikeApplicationPage() {
    if (!/^https?:/i.test(window.location.href)) return false;
    const identity = `${window.location.href} ${document.title}`.toLowerCase();
    const knownPage = /(workdayjobs|greenhouse|lever\.co|ashbyhq|icims|smartrecruiters|taleo|oraclecloud|darwinbox|keka|\/apply(?:\/|\?|$)|application)/.test(identity);
    const visibleFields = visibleFillableControls();
    // Fast path: a known board that already has a real form on it.
    if (knownPage && visibleFields.length >= 2) return true;
    // Generic fallback: two fillable controls are an application, whatever the
    // address says. A single search box never reaches this branch.
    if (visibleFields.length >= 2) return true;
    if (hasPlausibleFormContainer()) return true;
    // A form rendered entirely inside an iframe (SmartRecruiters one-click
    // apply) leaves this document with no fields of its own.
    return [...document.querySelectorAll('iframe, frame')].some(isPlausibleFormBox);
  }

  function removeReadyChip() {
    if (readyChipHost) readyChipHost.remove();
    readyChipHost = null;
    stopReadyChipWatch();
  }

  /** Drop the chip watch: it is only live while the chip is still undecided. */
  function stopReadyChipWatch() {
    if (chipObserver) {
      chipObserver.disconnect();
      chipObserver = null;
    }
    if (chipRetryTimer) {
      clearTimeout(chipRetryTimer);
      chipRetryTimer = null;
    }
    if (chipMountDebounce) {
      clearTimeout(chipMountDebounce);
      chipMountDebounce = null;
    }
  }

  /**
   * Mount the chip, and keep re-checking while the page is still not
   * qualifying. A single attempt 700 ms after injection missed Ashby, whose
   * form is client-rendered after that: the gate is re-read on page mutations
   * for a bounded window, and the watch ends as soon as the chip mounts or a
   * flow starts.
   */
  function ensureReadyChip() {
    if (readyChipHost || window.__autoapply_active || dismissedUrl === window.location.href) {
      stopReadyChipWatch();
      return;
    }
    mountReadyChip();
    if (readyChipHost) {
      stopReadyChipWatch();
      return;
    }
    if (chipObserver || !document.body) return;
    chipObserver = new MutationObserver(scheduleReadyChipCheck);
    chipObserver.observe(document.body, { childList: true, subtree: true });
    chipRetryTimer = setTimeout(stopReadyChipWatch, CHIP_MOUNT_RETRY_MS);
  }

  /** Page mutations arrive in bursts; one pending re-check is enough. */
  function scheduleReadyChipCheck() {
    if (chipMountDebounce) return;
    chipMountDebounce = setTimeout(() => {
      chipMountDebounce = null;
      ensureReadyChip();
    }, CHIP_MOUNT_DEBOUNCE_MS);
  }

  function mountReadyChip() {
    if (readyChipHost || window.__autoapply_active || !looksLikeApplicationPage()) return;
    if (dismissedUrl === window.location.href) return; // The user closed the panel on this URL.
    readyChipHost = document.createElement('div');
    readyChipHost.id = 'autoapply-ready-chip-host';
    document.body.appendChild(readyChipHost);
    const root = readyChipHost.attachShadow({ mode:'open' });
    const dark = resolvedTheme() === 'dark';
    const chipColors = dark
      ? { text:'#edf2f7', background:'#151d28', border:'#3c4b5e', hover:'#202b39', action:'#526ce7', focus:'#9aaeff' }
      : { text:'#19233a', background:'#ffffff', border:'#bcc6da', hover:'#e8edfa', action:'#3157d5', focus:'rgba(49,87,213,.45)' };
    root.innerHTML = `<style>
      button{position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;align-items:center;gap:9px;min-height:44px;padding:0 14px;border:1px solid ${chipColors.border};border-radius:8px;color:${chipColors.text};background:${chipColors.background};box-shadow:0 16px 42px rgba(0,0,0,.25);font:750 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
      button:hover{border-color:${chipColors.action};background:${chipColors.hover}}.autoapply-logo-icon{display:block;width:22px;height:22px;filter:drop-shadow(2px 2px 0 rgba(0,0,0,.16));transform:rotate(-1deg)}.autoapply-logo-icon svg{display:block;width:100%;height:100%}button:focus-visible{outline:3px solid ${chipColors.focus};outline-offset:3px}@media(prefers-reduced-motion:no-preference){button{animation:arrive .28s ease-out}@keyframes arrive{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}}</style><button type="button" aria-label="Prepare this application with AutoApply">${BRAND_MARK}Ready to prepare</button>`;
    root.querySelector('button').addEventListener('click', () => startScanningFlow());
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
    document.removeEventListener('keydown', handleOverlayKeydown, true);
    const focusWasInside = Boolean(shadowHost) && document.activeElement === shadowHost;
    if (shadowHost) {
      shadowHost.remove();
      shadowHost = null;
      shadowRoot = null;
      overlayContainer = null;
    }
    liveRegionEl = null;
    setHostPageHidden(false);
    if (focusWasInside && previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
      previousFocus.focus({ preventScroll: true });
    }
    previousFocus = null;
    if (pendingPageChange) pendingPageChange(false);
    if (pageChangeTimer) {
      clearTimeout(pageChangeTimer);
      pageChangeTimer = null;
    }
    if (activeObserver) {
      activeObserver.cancel();
      activeObserver = null;
    }
    FILLER.clearUploadHighlight();
    window.__autoapply_active = false;
    setTimeout(ensureReadyChip, 350);
  }

  /** Close the panel because the user asked for it; suppresses the chip on this URL. */
  function dismissOverlay() {
    dismissedUrl = window.location.href;
    removeOverlay();
  }

  /** Escape closes the panel — except at the field editor — and Tab stays inside it. */
  function handleOverlayKeydown(event) {
    if (!overlayContainer) return;
    if (event.key === 'Tab') {
      trapPanelFocus(event);
      return;
    }
    if (event.key !== 'Escape') return;
    if (overlayContainer.querySelector('.autoapply-field-input')) return;
    if (overlayContainer.querySelector('.autoapply-autorun-confirm')) {
      cancelAutoRun();
      return;
    }
    dismissOverlay();
  }

  /**
   * Display loading spinner inside the overlay.
   */
  function showLoading(text) {
    if (!overlayContainer) return;
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-loading">
        <div class="autoapply-spinner"></div>
        <div class="autoapply-loading-text">${UTILS.escapeHTML(text)}</div>
      </div>
    `;

    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', dismissOverlay);
    announce(text);
  }

  /**
   * Display error message inside the overlay.
   */
  function showError(msg) {
    if (!overlayContainer) return;
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-error">
        ${UTILS.escapeHTML(msg)}
      </div>
    `;

    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', dismissOverlay);
    announce(msg);
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

    const pageState = FILLER.isLastPage();
    const confirmation = isSubmissionConfirmationPage();
    const primaryLabel = confirmation ? 'Record submission' : hasFilledCurrentPage && pageState.isLast
      ? 'Review final page on employer site' : pageState.isLast ? 'Fill reviewed fields' : 'Fill & continue';
    overlayContainer.className = 'autoapply-overlay';
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-minimize-btn" title="Minimize" aria-label="Minimize">─</button>
          <button class="autoapply-header-btn autoapply-close-btn" title="Close" aria-label="Close">✕</button>
        </div>
      </div>

      <div class="autoapply-opportunity-heading">
        <p class="autoapply-kicker">Preparing now</p>
        <h2>${UTILS.escapeHTML(companyName || 'Company')} · ${UTILS.escapeHTML(roleName || 'Role')}</h2>
        <div class="autoapply-prep-summary"><span>${UTILS.escapeHTML(String(preparationSummary.ready_count))} ready</span><span>${UTILS.escapeHTML(String(preparationSummary.review_count))} to review</span><span>${UTILS.escapeHTML(String(preparationSummary.skipped_count))} skipped</span></div>
      </div>
      ${renderDuplicateWarning(cachedDuplicateRes)}
      ${renderAiWarning()}
      ${renderFrameNote()}
      ${renderWorkspaceContext()}
      ${renderFitScoreSection()}
      <div class="autoapply-fields">
        ${renderFieldGroups()}
      </div>
      <div class="autoapply-footer">
        <button class="autoapply-btn autoapply-btn-primary autoapply-primary-action-btn" ${hasFilledCurrentPage && pageState.isLast && !confirmation ? 'disabled' : ''}>${primaryLabel}</button>
        <details class="autoapply-more-actions"><summary aria-label="More actions">•••</summary><div class="autoapply-action-menu">
          <button type="button" class="autoapply-fill-only-btn">Fill without continuing</button>
          ${lastFillSnapshot.length || lastFillIncludedFrames ? '<button type="button" class="autoapply-undo-btn">Undo last fill</button>' : ''}
          <button type="button" class="autoapply-autopilot-btn" ${policyBlocksAutopilot() ? 'disabled title="Blocked by your fill rules"' : ''}>Fill and continue automatically</button>
        </div></details>
      </div>
    `;

    // Wire up events
    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', dismissOverlay);
    overlayContainer.querySelector('.autoapply-minimize-btn').addEventListener('click', toggleMinimize);

    // Enable drag
    setupDrag();

    // Match-score retry: this control is only rendered when a score is missing.
    const analyzeBtn = overlayContainer.querySelector('.autoapply-analyze-btn');
    if (analyzeBtn) analyzeBtn.addEventListener('click', () => analyzeFitProgressively());

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
        e.currentTarget.setAttribute('aria-expanded', String(isExpanded));
      });
    });

    overlayContainer.querySelector('.autoapply-primary-action-btn').addEventListener('click', () => {
      if (confirmation) confirmManualSubmission();
      else handleFill(!pageState.isLast);
    });
    overlayContainer.querySelector('.autoapply-fill-only-btn')?.addEventListener('click', () => handleFill(false));
    overlayContainer.querySelector('.autoapply-autopilot-btn')?.addEventListener('click', requestAutoRun);
    overlayContainer.querySelector('.autoapply-undo-btn')?.addEventListener('click', undoLastFill);

    const resumeVersion = overlayContainer.querySelector('.autoapply-resume-version');
    if (resumeVersion) {
      resumeVersion.addEventListener('change', (event) => {
        workspace.selectedResumeVersionId = event.target.value || null;
      });
    }
    overlayContainer.querySelectorAll('.autoapply-recover-btn').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        startEditingField(parseInt(event.currentTarget.getAttribute('data-idx'), 10));
      });
    });

    // Cover letter button events
    overlayContainer.querySelectorAll('.autoapply-gen-cover-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const idx = parseInt(e.currentTarget.getAttribute('data-idx'), 10);
        await generateCoverLetter(idx, e.currentTarget);
      });
    });

    // A re-render during a fill must not hand the controls back to the user.
    updateFillControls();
  }

  const CONFIRMATION_PATTERN = /(application (?:has been )?(?:submitted|received)|thank you for applying|we received your application)/i;

  /**
   * Decide whether the employer page is a post-submission confirmation. The phrase
   * also occurs in job descriptions and footers, so it must sit in a heading/alert
   * region and the page must have no remaining fillable application fields. The
   * record itself is still only written after the user confirms in the dialog.
   */
  function isSubmissionConfirmationPage() {
    if (receiptRecorded) return false;
    if (!CONFIRMATION_PATTERN.test(pageText())) return false;
    const claimed = [...document.querySelectorAll('h1, h2, [role="alert"], [role="status"], main')]
      .some((region) => CONFIRMATION_PATTERN.test(region.textContent || ''));
    return claimed && !hasFillableApplicationFields();
  }

  /** Visible application fields that are not site chrome (search, nav, header, footer). */
  function hasFillableApplicationFields() {
    return visibleFillableControls().length > 0;
  }

  function renderAiWarning() {
    if (!aiWarning) return '';
    return `
      <div class="autoapply-ai-warning" role="status" style="margin-top:8px;padding:8px;border-radius:6px;border:1px solid #f5c451;background:rgba(245,196,81,.12);font-size:11px;color:#f5c451;">
        AI suggestions are off right now. Your saved details still fill in. Check anything missing before you submit.
      </div>
    `;
  }

  /** One note per scan when an embedded form never answered the field request. */
  function renderFrameNote() {
    if (!frameNote) return '';
    return `
      <div class="autoapply-frame-note" role="status" style="margin-top:8px;padding:8px;border-radius:6px;border:1px solid #8fa2c9;background:rgba(143,162,201,.12);font-size:11px;">
        ${UTILS.escapeHTML(frameNote)}
      </div>
    `;
  }

  /**
   * A policy or unsupported skip is a row AutoApply declined on purpose — a
   * sensitive/demographic question or a third party's details. A skip with no
   * such source (a missing profile value, a failed mapping) is a gap, not a
   * policy decision, and stays visible with its own reason.
   */
  const POLICY_SKIP_SOURCE = /^(policy|unsupported|sensitive)/i;

  function isPolicySkip(instruction) {
    if (instruction.action !== 'skip') return false;
    return POLICY_SKIP_SOURCE.test(String(instruction.source || ''));
  }

  function instructionFor(fieldId) {
    return currentInstructions.find((item) => item.field_id === fieldId)
      || { field_id: fieldId, action: 'skip', review_required: true };
  }

  function renderFieldGroups() {
    const review = [];
    const ready = [];
    const skipped = [];
    const collapsed = [];
    pageFields.forEach((field, idx) => {
      const instruction = instructionFor(field.id);
      const entry = { field, idx, instruction };
      if (instruction.action !== 'skip') {
        (instruction.review_required ? review : ready).push(entry);
        return;
      }
      // A required field we will not fill is a blocker, so it stays in the group
      // the user actually sees rather than behind a collapsed summary.
      if (field.required) {
        review.push(entry);
        return;
      }
      (isPolicySkip(instruction) ? collapsed : skipped).push(entry);
    });
    const groups = [
      ['review', 'Needs review', 'Check these before filling', review, true],
      ['ready', 'Ready to fill', 'Verified profile facts and approved answers', ready, false],
      ['skipped', 'Skipped', 'Left untouched because the information is missing', skipped, false],
    ].filter(([, , , items]) => items.length)
      .map(([kind, title, copy, items, open]) => `<details class="autoapply-field-group autoapply-field-group-${kind}" ${open ? 'open' : ''}><summary><span><strong>${title}</strong><small>${copy}</small></span><b>${items.length}</b></summary><div>${items.map((entry) => renderFieldRow(entry.field, entry.idx)).join('')}</div></details>`);
    if (collapsed.length) {
      // One summary row instead of a wall of demographic fields: the reasons are
      // still here, one expansion away.
      groups.push(`
        <details class="autoapply-field-group autoapply-field-group-collapsed">
          <summary><span><strong>${collapsed.length} field${collapsed.length === 1 ? '' : 's'} left for you</strong><small>Sensitive or covered by your fill rules — open for each reason</small></span><b>${collapsed.length}</b></summary>
          <div>${collapsed.map((entry) => renderFieldRow(entry.field, entry.idx)).join('')}</div>
        </details>
      `);
    }
    return groups.join('') || '<div class="autoapply-empty-fields">No fillable fields were found on this page.</div>';
  }

  /**
   * Renders the minimized toggle button.
   */
  function renderMinimizedUI() {
    overlayContainer.className = 'autoapply-overlay autoapply-minimized';
    overlayContainer.innerHTML = `
      <div class="autoapply-mini-btn">
        ${BRAND_MARK}
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

  /** Plain wording for where a saved application stands. */
  const STATUS_LABELS = {
    saved: 'Saved',
    preparing: 'Being prepared',
    ready_to_review: 'Ready to check',
    submitted: 'Submitted',
    closed: 'Closed',
    archived: 'Archived',
  };

  function statusLabel(status) {
    const key = String(status || '').toLowerCase().trim();
    if (!key) return 'Saved';
    return STATUS_LABELS[key] || key.replace(/_/g, ' ');
  }

  /**
   * Helper to format the duplicate warning panel if duplicate found.
   */
  function renderDuplicateWarning(duplicateRes) {
    if (duplicateRes && duplicateRes.is_duplicate) {
      const existing = duplicateRes.existing;
      let info = 'This looks like an application you already saved in AutoApply.';
      if (existing && existing.applied_at) {
        const date = new Date(existing.applied_at).toLocaleDateString();
        info = `You already applied to this role on ${date}. Status: ${statusLabel(existing.status)}.`;
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
    // Nothing to score: the panel stays quiet rather than offering a control
    // that could not do anything.
    if (!jdText || jdText.length < 100) return '';
    if (!jobAnalysis) {
      if (fitAnalysisState === 'pending') {
        return `
          <div class="autoapply-fit-section autoapply-fit-loading">
            <span class="autoapply-fit-pulse"></span><span>Checking your match score…</span>
          </div>
        `;
      }
      // Failed, or never asked for: the panel offers the retry instead of a
      // spinner that never resolves.
      return `
        <div class="autoapply-fit-section autoapply-fit-loading">
          <span>${UTILS.escapeHTML(fitAnalysisMessage || 'No match score for this page yet.')}</span>
          <button type="button" class="autoapply-btn autoapply-analyze-btn autoapply-fit-retry">Check match score</button>
        </div>
      `;
    }

    const score = UTILS.escapeHTML(String(jobAnalysis.score ?? 0));
    const verdict = jobAnalysis.verdict || 'No verdict';
    const matched = jobAnalysis.matched_skills || [];
    const missing = jobAnalysis.missing_skills || [];

    return `
      <div class="autoapply-fit-section">
        <div class="autoapply-fit-header">
          <div class="autoapply-fit-score" aria-label="Match score ${score} out of 100">${score} out of 100</div>
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
   * How sure AutoApply is about an answer, in the panel's own words. The key
   * also picks the dot's class, so only a known word ever reaches the markup.
   */
  const CONFIDENCE_COPY = {
    high: "We're confident",
    medium: 'Please check',
    low: 'Please check',
    skip: 'Not sure',
  };

  function confidenceKey(value) {
    const key = String(value || '').toLowerCase();
    return CONFIDENCE_COPY[key] ? key : 'medium';
  }

  /**
   * Plain wording for why AutoApply left a field alone. The backend writes
   * these in the panel's vocabulary; the ones we know are said in plain words,
   * and anything else is shown as written (escaped) rather than hidden.
   */
  const FIELD_REASON_COPY = [
    [/skipped by the mapping/i, 'No matching answer for this field.'],
    [/review this sensitive field/i, 'Please answer this sensitive question yourself.'],
    [/autofill policy says never fill/i, 'Your fill rules say to leave this one to you.'],
    [/autofill policy requires review/i, 'Your fill rules say to check this one yourself.'],
    [/asks for someone else's contact details/i, "This asks for someone else's contact details."],
    [/asks about someone else's website or profile/i, "This asks about someone else's website or profile."],
    [/^add a github url/i, 'Add your GitHub link in AutoApply.'],
    [/^add a portfolio url/i, 'Add your portfolio link in AutoApply.'],
    [/cannot determine value/i, 'AutoApply has no saved answer for this question.'],
  ];

  function plainFieldReason(reason) {
    const text = String(reason || '').trim();
    if (!text) return 'No matching answer for this field.';
    for (const [pattern, copy] of FIELD_REASON_COPY) if (pattern.test(text)) return copy;
    return plainPhrase(text);
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
      displayValue = plainFieldReason(inst.reason);
    } else if (field.type === 'password') {
      displayValue = '••••••••';
    }

    const confidence = confidenceKey(inst.confidence);
    const confidenceCopy = CONFIDENCE_COPY[confidence];
    const dotClass = `autoapply-confidence-dot ${confidence}`;
    const isExpandable = displayValue.length > 100 && inst.action !== 'skip';
    const valClass = `autoapply-field-value ${inst.action === 'skip' ? 'skip' : ''}${isExpandable ? ' expandable' : ''}`;
    const toggleHtml = isExpandable ? `<button class="autoapply-expand-toggle" data-idx="${idx}" aria-expanded="false" aria-controls="val_${idx}">▼ more</button>` : '';

    const labelLower = (field.label || field.placeholder || field.name || '').toLowerCase();
    const isCoverLetter = (field.type === 'textarea' || field.type === 'text') && (
      labelLower.includes('cover letter') || labelLower.includes('cover_letter') 
      || labelLower.includes('coverletter') || labelLower.includes('letter of interest')
    );

    const coverLetterBtnHtml = isCoverLetter ? `
      <div style="margin-top: 6px;">
        <button class="autoapply-btn autoapply-gen-cover-btn" data-idx="${idx}" style="font-size: 11px; padding: 4px 8px; width: auto; height: auto; cursor: pointer;">
          ✍ Generate Cover Letter
        </button>
      </div>
    ` : '';
    const failure = fieldFailures.get(field.id);
    // A field inside an embedded frame has no element in this document, so the
    // inline editor cannot reach it: the reason still shows, and the user edits
    // it on the page itself.
    const failureHtml = failure ? `
      <div style="margin-top:6px;font-size:11px;color:#fca5a5;">Could not fill: ${UTILS.escapeHTML(failure.reason)}</div>
    ` : '';
    const recoveryHtml = failure && !field.frameTag ? `
      <button class="autoapply-recover-btn" data-idx="${idx}" style="margin-top:4px;font-size:11px;">Edit this answer</button>
    ` : '';
    const editHtml = field.frameTag
      ? '<span class="autoapply-edit-note" style="flex-shrink:0;margin-top:2px;font-size:10px;color:#8b93a7;white-space:nowrap;">edit on the page</span>'
      : `<button class="autoapply-edit-btn" data-idx="${idx}" title="Edit this answer" aria-label="Edit this answer">✎</button>`;
    const source = inst.source || (inst.action === 'skip' ? 'policy' : 'ai');
    const sourceLabel = source.startsWith('profile') ? 'Verified profile' : source.startsWith('answer_vault') ? 'Saved answer' : source.startsWith('resume') ? 'Resume file' : source.startsWith('learned') ? 'Corrected by you' : source.startsWith('policy') ? 'Fill rules' : 'AI suggestion';

    return `
      <div class="autoapply-field-row" id="row_${idx}">
        <div class="${dotClass}" title="${UTILS.escapeHTML(confidenceCopy)}"></div>
        <div class="autoapply-field-info">
          <div class="autoapply-field-label">${UTILS.escapeHTML(field.label || field.placeholder || field.name || 'Unnamed Field')} ${field.required ? '<span style="color:#c84545">*</span>' : ''}</div>
          <div class="${valClass}" id="val_${idx}">${UTILS.escapeHTML(displayValue)}</div>
          <div class="autoapply-field-source">${UTILS.escapeHTML(sourceLabel)} · ${UTILS.escapeHTML(confidenceCopy)}</div>
          ${toggleHtml}
          ${coverLetterBtnHtml}
          ${failureHtml}
          ${recoveryHtml}
        </div>
        ${editHtml}
      </div>
    `;
  }

  // Removed duplicate setupDrag() definition

  /**
   * Switch a field row into editing mode with an input/select.
   */
  function startEditingField(idx) {
    const field = pageFields[idx];
    if (!field) return;
    if (field.frameTag) {
      // The element lives in another document; only the page can edit it.
      showStatus('This field is part of a form inside this page. Edit it on the page itself.', true);
      return;
    }
    const row = overlayContainer.querySelector(`#row_${idx}`);
    const valDiv = overlayContainer.querySelector(`#val_${idx}`);
    if (!row || !valDiv) return;

    const fieldId = field.id;
    const inst = currentInstructions.find(i => i.field_id === fieldId) || {
      field_id: fieldId,
      action: 'fill',
      value: '',
      confidence: 'medium'
    };

    // The row's label is a plain div, so each control carries the same words
    // as its own accessible name.
    const controlLabel = field.label || field.placeholder || field.name || 'Unnamed Field';

    let inputHtml = '';

    if (field.type === 'select' && field.options && field.options.length > 0) {
      inputHtml = `
        <select class="autoapply-field-input" id="input_${idx}" aria-label="${UTILS.escapeHTML(controlLabel)}">
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
        <textarea class="autoapply-field-input" id="input_${idx}" rows="3" aria-label="${UTILS.escapeHTML(controlLabel)}">${UTILS.escapeHTML(inst.value || '')}</textarea>
      `;
    } else {
      inputHtml = `
        <input type="text" class="autoapply-field-input" id="input_${idx}" aria-label="${UTILS.escapeHTML(controlLabel)}" value="${UTILS.escapeHTML(inst.value || '')}">
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
        <button class="autoapply-header-btn autoapply-save-btn" data-idx="${idx}" title="Save this answer" aria-label="Save this answer" style="align-self: flex-start; padding: 6px 10px;">✓</button>
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
    inst.review_required = false;

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
    captureTeach(field, oldValue, newValue);
    saveWorkspacePacket('ready_to_review');

    // Refresh UI to display updated value
    renderMainUI();
  }

  async function fillCurrentInstructions(stage) {
    fieldFailures.clear();
    const { mine, byFrame } = splitInstructions(currentInstructions);
    lastFillSnapshot = captureFillSnapshot(mine);
    const result = await FILLER.fillAllFields(mine, {
      uploadHandler: attachSelectedResume,
    });
    // Embedded fields are filled by the frame that owns them; its answer joins
    // the page-level counts so the panel and the gate see one result.
    const embedded = await fillChildFrames(byFrame);
    result.filled += embedded.filled;
    result.skipped += embedded.skipped;
    result.failed += embedded.failed;
    result.failures = [...(result.failures || []), ...embedded.failures];
    for (const failure of result.failures) fieldFailures.set(failure.field_id, failure);
    await saveWorkspacePacket(stage, result);
    return result;
  }

  async function undoLastFill() {
    if (!lastFillSnapshot.length && !lastFillIncludedFrames) return;
    restoreFillSnapshot(lastFillSnapshot);
    lastFillSnapshot = [];
    await clearChildFrames();
    lastFillIncludedFrames = false;
    hasFilledCurrentPage = false;
    renderMainUI();
    showStatus('Restored the values from before the last fill.', false);
  }

  /**
   * Ask before an unattended run. The loop fills page after page and moves on
   * by itself, so the user confirms that in the panel — never in a browser
   * dialog, which can neither explain the run nor be styled or dismissed here.
   */
  function requestAutoRun() {
    if (policyBlocksAutopilot()) {
      showStatus(`Auto-run is blocked by your fill rules. ${plainPhrase(policyMessage())}`.trim(), true);
      return;
    }
    renderAutoRunConfirm();
  }

  /** The confirmation view. Escape, the ✕ and "Not now" all leave it. */
  function renderAutoRunConfirm() {
    if (!overlayContainer) return;
    autopilotState = 'starting';
    autopilotMessage = '';
    overlayContainer.className = 'autoapply-overlay';
    overlayContainer.innerHTML = `
      <div class="autoapply-header">
        <div class="autoapply-logo">
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-autorun-confirm">
        <p class="autoapply-kicker">Fill and continue automatically</p>
        <h2>Fill every page without stopping to ask?</h2>
        <p>AutoApply fills this page, then moves to the next one on its own.</p>
        <p>It stops as soon as a question needs you, and AutoApply never clicks the final Submit button.</p>
        <div class="autoapply-choice-actions">
          <button class="autoapply-btn autoapply-btn-primary autoapply-autorun-start-btn">Start filling</button>
          <button class="autoapply-btn autoapply-btn-secondary autoapply-autorun-cancel-btn">Not now</button>
        </div>
      </div>
    `;
    overlayContainer.querySelector('.autoapply-close-btn').addEventListener('click', cancelAutoRun);
    overlayContainer.querySelector('.autoapply-autorun-start-btn').addEventListener('click', beginAutoRun);
    overlayContainer.querySelector('.autoapply-autorun-cancel-btn').addEventListener('click', cancelAutoRun);
    overlayContainer.querySelector('.autoapply-autorun-start-btn').focus({ preventScroll: true });
    announce('Fill every page automatically? AutoApply fills each page and moves on by itself. It never clicks the final Submit button.');
  }

  /** The user confirmed: hand the page over to the loop. */
  function beginAutoRun() {
    const startBtn = overlayContainer?.querySelector('.autoapply-autorun-start-btn');
    if (startBtn) {
      startBtn.setAttribute('disabled', '');
      startBtn.textContent = 'Starting…';
    }
    runAutoPilot();
  }

  /** "Not now": nothing was started and nothing on the page was touched. */
  function cancelAutoRun() {
    autopilotState = 'idle';
    autopilotMessage = '';
    renderMainUI();
    showStatus('Auto-run was not started. Nothing was submitted.', false);
  }

  /**
   * Run the AutoPilot loop: scrape, get backend instructions, fill, advance, detect page change, and repeat.
   */
  async function runAutoPilot() {
    if (policyBlocksAutopilot()) {
      showStatus(`Auto-run is blocked by your fill rules. ${plainPhrase(policyMessage())}`.trim(), true);
      return;
    }
    autopilotActive = true;
    autopilotStep = 0;
    autopilotState = 'running';
    autopilotMessage = '';
    lastFilledPageSignature = null;
    samePageFillCount = 0;
    let advanced = false; // Did the previous iteration observe a real step change?
    
    while (autopilotActive) {
      autopilotStep++;
      
      if (autopilotStep > MAX_AUTOPILOT_STEPS) {
        stopAutoPilot(`Stopped after ${MAX_AUTOPILOT_STEPS} pages in a row. Nothing was submitted.`, 'failed');
        return;
      }
      
      showAutoPilotStatus(`Filling page ${autopilotStep}…`);
      
      // 1. Scrape the current page and its embedded frames
      try {
        await scanPageFields();
      } catch (err) {
        console.error('[AutoApply] AutoPilot scraper error:', err);
        stopAutoPilot('AutoApply couldn\'t read this page. Reload the page and try again.', 'failed');
        return;
      }

      // Guard: do not re-fill a page the site refuses to advance past
      const signature = pageSignature();
      if (signature === lastFilledPageSignature && !advanced) samePageFillCount += 1;
      else {
        lastFilledPageSignature = signature;
        samePageFillCount = 1;
      }
      if (samePageFillCount > MAX_SAME_PAGE_FILLS) {
        const blocking = blockingRequiredFields();
        const blockingText = blocking.length
          ? `Still required: ${blocking.slice(0, 5).join(', ')}.`
          : 'Check the fields the site marked as required.';
        const message = `This page did not move on after ${MAX_SAME_PAGE_FILLS} tries. ${blockingText} Nothing was submitted.`;
        stopAutoPilot(message, 'failed');
        renderMainUI();
        showStatus(message, true);
        return;
      }
      
      if (pageFields.length === 0) {
        // No fields found - might be a confirmation or loading page
        // Wait a bit and check if it's the last page
        await new Promise(r => setTimeout(r, 1000));
        const lastCheck = FILLER.isLastPage();
        if (lastCheck.isLast) {
          stopAutoPilot('Auto-run finished. Check the form on the employer site, then submit it yourself.', 'ready_to_review');
          logApplicationToHistory();
          return;
        }
      }
      
      // 2. Get fill instructions from backend
      const url = window.location.href;
      const title = document.title;
      const platform = UTILS.detectPlatform(url);
      companyName = UTILS.extractCompany(url, title);
      roleName = UTILS.extractRole(url, title, document);
      
      const declared = declaredPageStep();
      const formSchema = {
        url, platform, page_title: title,
        step: declared?.step || autopilotStep, total_steps: declared?.total_steps ?? null,
        fields: pageFields, job_description: jdText,
        opportunity_id: workspace.opportunityId,
        resume_version_id: workspace.selectedResumeVersionId
      };
      
      try {
        const autofillRes = await UTILS.apiCall('/api/autofill', 'POST', formSchema);
        currentInstructions = autofillRes.instructions || [];
        aiWarning = autofillRes.ai_error || '';
      } catch (err) {
        console.error('[AutoApply] AutoPilot autofill request failed:', err);
        stopAutoPilot('Can\'t reach AutoApply, so Auto-run stopped. Nothing was submitted.', 'failed');
        return;
      }
      
      if (!autopilotActive) return; // User clicked stop during API call
      
      // 3. Fill all fields
      const result = await fillCurrentInstructions('autopilot_filled');
      const optionalFailures = failedFieldLabels(result.failures.filter((failure) => !pageFields.find((field) => field.id === failure.field_id)?.required));
      showAutoPilotStatus(
        `Page ${autopilotStep}: ${result.filled} filled, ${result.skipped} skipped, ${result.failed} left for you.`
      );
      const blocking = blockingRequiredFields();
      if (blocking.length) {
        const message = `Stopped so you can finish these fields: ${blocking.slice(0, 5).join(', ')}. Nothing was submitted.`;
        stopAutoPilot(message, 'failed');
        renderMainUI();
        showStatus(message, true);
        return;
      }
      if (optionalFailures.length) {
        console.warn(`[AutoApply] AutoPilot continuing past optional field failures: ${optionalFailures.join(', ')}`);
      }
      
      // 4. Wait for React/Angular to settle
      await new Promise(r => setTimeout(r, 800));
      
      // 5. Check if this is the last page
      const lastPageInfo = FILLER.isLastPage();
      if (lastPageInfo.isLast) {
        autopilotActive = false;
        autopilotState = 'ready_to_review';
        console.log(`[AutoApply] AutoPilot stopped on the last page: ${lastPageInfo.reason}`);
        autopilotMessage = 'Auto-run finished at the end of the form. Check every answer, then submit it yourself.';
        showAutoPilotStatus(autopilotMessage);
        logApplicationToHistory();
        // Re-render the full UI so user can review final page
        renderMainUI();
        return;
      }
      
      // 6. Click next and wait for page change
      const clicked = FILLER.clickNextButton();
      if (!clicked) {
        stopAutoPilot('No Next or Continue button on this page, so Auto-run stopped. Nothing was submitted.', 'failed');
        return;
      }
      
      showAutoPilotStatus(`Moving to page ${autopilotStep + 1}…${optionalFailures.length ? ` Still yours to fill: ${optionalFailures.join(', ')}.` : ''}`);
      
      // 7. Wait for a real step change (bounded; a slow page is caught by the loop guard above)
      advanced = await waitForPageChange(AUTOPILOT_PAGE_CHANGE_TIMEOUT_MS);
      if (!advanced) console.warn('[AutoApply] No page change detected before the AutoPilot timeout.');
      
      if (!autopilotActive) return;
      
      // 8. Small delay then loop
      await new Promise(r => setTimeout(r, 500));
    }
  }

  /**
   * Stop AutoPilot and optionally show a status message.
   */
  function stopAutoPilot(message, outcome = 'stopped') {
    autopilotActive = false;
    autopilotState = outcome;
    autopilotMessage = message || '';
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
          ${BRAND_MARK}
          <span>AutoApply</span>
        </div>
        <div class="autoapply-header-actions">
          <button class="autoapply-header-btn autoapply-close-btn" title="Close" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="autoapply-autopilot-status">
        <div class="autoapply-autopilot-indicator ${autopilotActive ? 'active' : 'done'}"></div>
        <div class="autoapply-autopilot-text">${UTILS.escapeHTML(text)}</div>
      </div>
      ${autopilotActive ? `
        <div class="autoapply-footer">
          <button class="autoapply-btn autoapply-stop-btn">Stop Auto-run</button>
        </div>
      ` : `
        <div class="autoapply-footer">
          <button class="autoapply-btn autoapply-btn-secondary autoapply-close-final-btn">Close</button>
        </div>
      `}
    `;
    announce(text);
    
    const closeBtn = overlayContainer.querySelector('.autoapply-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', () => { stopAutoPilot(); dismissOverlay(); });
    
    const stopBtn = overlayContainer.querySelector('.autoapply-stop-btn');
    if (stopBtn) stopBtn.addEventListener('click', () => {
      stopAutoPilot('Auto-run stopped. Nothing was submitted.');
      renderMainUI();
    });
    
    const closeFinalBtn = overlayContainer.querySelector('.autoapply-close-final-btn');
    if (closeFinalBtn) closeFinalBtn.addEventListener('click', dismissOverlay);
  }

  /** Save a prepared application without claiming it was submitted. */
  function logApplicationToHistory() {
    saveWorkspacePacket('ready_to_review').then((packet) => {
      if (packet) showStatus('Saved for review. AutoApply did not submit anything.', false);
      else showStatus('Nothing was submitted, but AutoApply could not save this to your applications.', true);
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
      showStatus(`AutoApply could not write the cover letter. ${plainFailureReason(err?.detail)}`, true);
    }
  }

  /**
   * Mark a fill as running (or finished) and mirror that onto the controls: the
   * primary button and every ••• action are unavailable until it settles, and
   * the button says what is happening.
   */
  function setFillInFlight(value) {
    fillInFlight = value;
    updateFillControls();
  }

  /** Reflect the in-flight state onto whatever the panel is showing right now. */
  function updateFillControls() {
    if (!overlayContainer) return;
    const primary = overlayContainer.querySelector('.autoapply-primary-action-btn');
    if (primary) {
      if (fillInFlight) {
        if (!primary.hasAttribute('data-autoapply-idle-label')) {
          // Remember what the button said, and whether the page had already
          // disabled it, so the state is restored rather than guessed.
          primary.setAttribute('data-autoapply-idle-label', primary.textContent);
          primary.setAttribute('data-autoapply-was-disabled', primary.hasAttribute('disabled') ? '1' : '0');
        }
        primary.textContent = 'Filling…';
        primary.setAttribute('disabled', '');
      } else if (primary.hasAttribute('data-autoapply-idle-label')) {
        primary.textContent = primary.getAttribute('data-autoapply-idle-label');
        if (primary.getAttribute('data-autoapply-was-disabled') === '1') primary.setAttribute('disabled', '');
        else primary.removeAttribute('disabled');
        primary.removeAttribute('data-autoapply-idle-label');
        primary.removeAttribute('data-autoapply-was-disabled');
      }
    }
    overlayContainer.querySelectorAll('.autoapply-action-menu button').forEach((button) => {
      if (fillInFlight) {
        if (!button.hasAttribute('data-autoapply-was-disabled')) {
          button.setAttribute('data-autoapply-was-disabled', button.hasAttribute('disabled') ? '1' : '0');
        }
        button.setAttribute('disabled', '');
      } else if (button.hasAttribute('data-autoapply-was-disabled')) {
        if (button.getAttribute('data-autoapply-was-disabled') === '0') button.removeAttribute('disabled');
        button.removeAttribute('data-autoapply-was-disabled');
      }
    });
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
    if (fillInFlight) {
      // A second click while the first fill is still running is not a second fill.
      console.log('[AutoApply] A fill is already running; ignoring the duplicate trigger.');
      return;
    }
    setFillInFlight(true);

    try {
      pageText(true); // The user is acting on the page now; refresh the cached page text.

      // 1. Programmatically fill all inputs on the active DOM
      const result = await fillCurrentInstructions(advance ? 'filled_for_next' : 'filled_for_review');
      hasFilledCurrentPage = result.filled > 0;
      const optionalFailures = failedFieldLabels(result.failures.filter((failure) => !pageFields.find((field) => field.id === failure.field_id)?.required));
      const blocking = blockingRequiredFields();
      if (blocking.length) {
        renderMainUI();
        showStatus(`Still required: ${blocking.join(', ')}. Answer them in this panel, then continue. Nothing was submitted.`, true);
        return;
      }
      if (optionalFailures.length) {
        showStatus(`Filled ${result.filled}. ${optionalFailures.length} optional field${optionalFailures.length === 1 ? '' : 's'} need your attention: ${optionalFailures.join(', ')}.`, false);
      } else {
        showStatus(`Filled ${result.filled}; ${result.skipped} skipped and ${result.failed} left for you.`, false);
      }

      if (advance) {
        // Small delay to ensure all async React/Angular updates settle
        await new Promise(resolve => setTimeout(resolve, 500));

        // 2. Click page continue button
        const clicked = FILLER.clickNextButton();

        if (clicked) {
          showStatus('Form filled. Moving to next page...', false);

          // 3. Wait for a real step change, bounded, then re-scan the next step
          const advanced = await waitForPageChange(PAGE_CHANGE_TIMEOUT_MS);
          if (!window.__autoapply_active) return; // The user closed the panel while waiting.
          if (!advanced) console.warn('[AutoApply] No confirmed page change; refreshing the review for the current page.');
          startScanningFlow({ force: true });
        } else {
          showStatus('Filled fields, but no Next/Continue button could be detected.', true);
        }
      } else {
        renderMainUI();
        showStatus('Fields are filled. Review the employer page before submitting.', false);
      }
    } finally {
      setFillInFlight(false);
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

    const statusText = document.createElement('span');
    statusText.textContent = text;
    statusDiv.appendChild(statusText);

    // Every banner can be dismissed; an error banner is never taken away on a
    // timer, so the user decides when it goes.
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'autoapply-status-dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss this message');
    dismissBtn.title = 'Dismiss';
    dismissBtn.textContent = '✕';
    dismissBtn.addEventListener('click', () => statusDiv.remove());
    statusDiv.appendChild(dismissBtn);

    // Append above footer or at the bottom
    const footer = overlayContainer.querySelector('.autoapply-footer');
    if (footer) {
      overlayContainer.insertBefore(statusDiv, footer);
    } else {
      overlayContainer.appendChild(statusDiv);
    }

    announce(text);

    // Auto-remove standard status messages after 5 seconds unless it's a critical error
    if (!isError) {
      setTimeout(() => {
        statusDiv.remove();
      }, 5000);
    }
  }



  /**
   * Register this frame's role. The top frame owns the panel, the chip, the
   * backend flow, and the keyboard/theme listeners. A child frame registers the
   * responder and nothing else: no panel, no chip, no scan, no backend call —
   * a page full of ad frames costs one scrape message each and nothing more.
   */
  function startOverlay() {
    if (!IS_TOP_FRAME) {
      registerChildResponder();
      return;
    }
    // Register listeners for messages from the background script
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'START_AUTOFILL') {
        // An explicit start — the shortcut, or the popup — always wins over a
        // panel this URL was dismissed on earlier.
        dismissedUrl = null;
        startScanningFlow();
        sendResponse({ status: 'started' });
      } else if (message.type === 'GET_STATUS') {
        sendResponse({ status: window.__autoapply_active ? 'active' : 'idle' });
      } else if (message.type === 'AA_DETECT_APPLICATION') {
        // The popup cannot read the page itself; it asks this gate, so both
        // agree on what counts as an application.
        sendResponse({ ok: true, detected: looksLikeApplicationPage() });
      } else if (message.type === 'START_AUTOPILOT') {
        dismissedUrl = null;
        autopilotState = 'starting';
        autopilotMessage = '';
        startScanningFlow()
          .then(() => { if (overlayContainer) requestAutoRun(); })
          .catch((err) => stopAutoPilot(`Auto-run could not start: ${plainPhrase(err?.message)}`, 'failed'));
        sendResponse({ status: 'started' });
      } else if (message.type === 'GET_AUTOPILOT_STATUS') {
        sendResponse({
          autopilotActive,
          autopilotStep,
          autopilotState,
          message: autopilotMessage
        });
      } else if (message.type === 'PREPARE_APPLICATION') {
        prepareApplicationSilently(message).then(sendResponse);
        return true;
      }
    });

    watchFrameReplies();

    colorScheme.addEventListener('change', () => {
      if (themePreference !== 'system') return;
      applyOverlayTheme();
      if (readyChipHost) { removeReadyChip(); ensureReadyChip(); }
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[THEME_KEY]) return;
      themePreference = themeChoices.has(changes[THEME_KEY].newValue) ? changes[THEME_KEY].newValue : 'system';
      applyOverlayTheme();
      if (readyChipHost) { removeReadyChip(); ensureReadyChip(); }
    });

    initializeTheme();
    setTimeout(ensureReadyChip, 700);
  }

  startOverlay();
  console.log('[AutoApply] Review Overlay module loaded successfully.');
})();
