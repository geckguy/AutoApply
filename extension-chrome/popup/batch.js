document.addEventListener('DOMContentLoaded', () => {
  const UTILS = window.__autoapply_utils;
  const STORAGE_KEY = 'autoapply_batch_preparation_v2';
  const THEME_KEY = 'autoapply_theme';
  const themeChoices = new Set(['system', 'light', 'dark']);
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  const $ = (selector) => document.querySelector(selector);
  const FINISHED = ['ready', 'reused', 'skipped'];
  const UNDO_WINDOW_MS = 12000;
  const FALLBACK_FAILURE = 'AutoApply couldn’t prepare this page. Open it in a tab and try again.';
  // Employer pages and failures hand us raw text. Addresses, ports, setting
  // names and status codes are technical: they never reach the interface.
  const TECHNICAL = /(https?:\/\/|localhost|127\.0\.0\.1|\bport\b|:\d{2,5}\b|\bAPI\b|\bfetch\b|\bnetwork\b|receiving end|establish connection|no receiver|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|\b(?:HTTP|status|code)\s*\d{3}\b)/i;
  const TERSER_FAILURE = /^(?:the )?preparation (?:failed|did not finish)\.?$/i;
  const STATUS_TEXT = {
    queued: 'Waiting to prepare',
    running: 'Preparing now',
    ready: 'Ready to review',
    reused: 'Already saved',
    duplicate: 'Looks like an application you already saved',
    failed: 'Couldn’t prepare',
    skipped: 'Skipped',
  };
  let batch = { items:[], running:false };
  let themePreference = 'system';
  let lastAnnouncement = '';
  let toastTimer = null;

  function applyTheme() {
    document.documentElement.dataset.theme = themePreference === 'system' ? (colorScheme.matches ? 'dark' : 'light') : themePreference;
    $('#theme-select').value = themePreference;
  }

  async function initializeTheme() {
    const saved = await browser.storage.local.get(THEME_KEY);
    themePreference = themeChoices.has(saved[THEME_KEY]) ? saved[THEME_KEY] : 'system';
    applyTheme();
  }

  function validUrls() {
    return [...new Set($('#batch-urls').value.split(/\r?\n/).map((value) => value.trim()).filter((value) => {
      try { return ['http:','https:'].includes(new URL(value).protocol); } catch (_) { return false; }
    }))];
  }

  /** Every page-derived and error-derived value goes through here before innerHTML. */
  function escape(value) {
    return UTILS.escapeHTML(String(value === null || value === undefined ? '' : value));
  }

  /** A failure sentence the user can act on, never the raw text of one. */
  function plainFailure(raw) {
    const text = String(raw || '').trim();
    if (!text || TERSER_FAILURE.test(text) || TECHNICAL.test(text)) return FALLBACK_FAILURE;
    return /[.!?]$/.test(text) ? text : `${text}.`;
  }

  function label(item) {
    return item.title || host(item.url);
  }

  function host(url) {
    try { return new URL(url).hostname.replace(/^www\./,''); } catch (_) { return url; }
  }

  function announce(message) {
    if (!message || message === lastAnnouncement) return;
    lastAnnouncement = message;
    $('#batch-announcer').textContent = message;
  }

  function hideToast() {
    clearTimeout(toastTimer);
    $('#toast').className = 'toast';
    const button = $('#toast-undo');
    button.hidden = true;
    button.onclick = null;
  }

  /**
   * Show a message, optionally with an Undo action. The window is longer when
   * there is something to undo, because the user has to notice and decide.
   */
  function toast(message, undo = null) {
    $('#toast-message').textContent = message;
    $('#toast').className = 'toast show';
    const button = $('#toast-undo');
    if (undo) {
      button.hidden = false;
      button.textContent = undo.label || 'Undo';
      button.onclick = () => { hideToast(); undo.run(); };
    } else {
      button.hidden = true;
      button.onclick = null;
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, undo ? UNDO_WINDOW_MS : 5000);
  }

  async function persist() { await browser.storage.local.set({ [STORAGE_KEY]:batch }); }

  /**
   * Reload the saved list. A row left mid-flight by a closed page is a dead end:
   * it is handed back to the queue so the next run prepares it.
   */
  async function restore() {
    const saved = await browser.storage.local.get(STORAGE_KEY);
    if (saved[STORAGE_KEY]) {
      batch = { ...saved[STORAGE_KEY], running:false };
      let stranded = 0;
      for (const item of batch.items) {
        if (item.status === 'running') {
          item.status = 'queued';
          item.message = STATUS_TEXT.queued;
          stranded += 1;
        }
      }
      if (stranded) await persist();
    }
    render();
  }

  /** Detail line. A duplicate shows the saved record it was matched against. */
  function detailHTML(item) {
    if (item.status === 'duplicate') {
      const match = (item.matches || [])[0] || {};
      const role = String(match.role || '').trim();
      const company = String(match.company || '').trim();
      if (role && company) return `Saved as ${escape(role)} at ${escape(company)}`;
      if (role) return `Saved as ${escape(role)}`;
      if (company) return `Saved at ${escape(company)}`;
    }
    if (item.status === 'failed') return escape(plainFailure(item.message));
    return escape(item.message || STATUS_TEXT[item.status] || item.status);
  }

  function rowActions(item) {
    const id = escape(item.id);
    const named = (action) => `aria-label="${escape(`${action}: ${label(item)}`)}"`;
    if (item.status === 'duplicate') return `<button data-batch-reuse="${id}" ${named('Open tracked')}>Open tracked</button><button data-batch-new="${id}" ${named('Prepare another')}>Prepare another</button>`;
    if (item.status === 'failed') return `<button data-batch-retry="${id}" ${named('Retry')}>Retry</button><button data-batch-skip="${id}" ${named('Skip')}>Skip</button>`;
    if (item.status === 'running' || item.status === 'skipped') return `<button data-batch-retry="${id}" ${named('Retry')}>Retry</button>`;
    if (['ready','reused'].includes(item.status)) return `<button data-batch-review="${id}" ${named('Review')}>Review</button>`;
    return '';
  }

  function summarize() {
    const complete = batch.items.filter((item) => ['ready','reused'].includes(item.status)).length;
    const waiting = batch.items.filter((item) => ['queued','running'].includes(item.status)).length;
    const failed = batch.items.filter((item) => item.status === 'failed').length;
    const running = batch.items.find((item) => item.status === 'running');
    const parts = [`${complete} of ${batch.items.length} prepared`];
    if (waiting) parts.push(`${waiting} still to prepare`);
    if (failed) parts.push(`${failed} could not be prepared`);
    return { complete, waiting, failed, running, text: running ? `Preparing ${label(running)}. ${parts.join(', ')}.` : `${parts.join(', ')}.` };
  }

  function render() {
    const state = summarize();
    $('#batch-summary').innerHTML = `<span>${state.running ? 'Preparing now. Keep this page open.' : state.waiting ? 'Ready to continue' : 'Preparation status'}</span><strong>${state.complete}/${batch.items.length} prepared</strong>`;
    $('#batch-list').innerHTML = batch.items.length ? batch.items.map((item) => `<article class="batch-row ${escape(item.status)}"><i aria-hidden="true"></i><div><strong>${escape(label(item))}</strong><small>${detailHTML(item)}</small></div><div class="row-actions">${rowActions(item)}</div></article>`).join('') : '<div class="empty">Add job links to begin. Keep this page open while AutoApply works.</div>';
    announce(batch.items.length ? state.text : 'The preparation list is empty.');
  }

  function waitForTab(tabId) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; browser.tabs.onUpdated.removeListener(listener); resolve(); };
      const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
      browser.tabs.onUpdated.addListener(listener);
      setTimeout(finish, 30000);
    });
  }

  async function prepareItem(item, resolution = null, existingId = null) {
    item.status = 'running'; item.message = 'Opening application page…'; render(); await persist();
    let tab;
    try {
      tab = await browser.tabs.create({ url:item.url, active:false });
      await waitForTab(tab.id);
      item.message = 'Scanning fields and preparing answers…'; render();
      const result = await browser.tabs.sendMessage(tab.id, { type:'PREPARE_APPLICATION', duplicate_resolution:resolution, existing_id:existingId });
      if (!result?.ok) throw new Error(result?.error || 'Preparation did not finish');
      item.matches = null; item.existingId = null;
      if (result.status === 'duplicate') {
        item.status = 'duplicate'; item.matches = result.matches || []; item.existingId = item.matches[0]?.id || null;
        item.title = result.title || item.title; item.message = 'Looks like an application you already saved';
      } else {
        item.status = result.reused ? 'reused' : 'ready'; item.opportunityId = result.opportunity_id;
        item.title = result.title || item.title;
        item.message = `${result.ready_count || 0} ready · ${result.review_count || 0} to review${typeof result.fit_score === 'number' ? ` · ${result.fit_score}% match` : ''}`;
      }
    } catch (error) {
      item.status = 'failed'; item.message = plainFailure(error.message);
    } finally {
      if (tab?.id) await browser.tabs.remove(tab.id).catch(() => {});
      await persist(); render();
    }
  }

  async function runQueue() {
    if (batch.running) return;
    batch.running = true; await persist(); render();
    try {
      for (const item of batch.items) if (item.status === 'queued') await prepareItem(item);
    } finally {
      batch.running = false; await persist(); render();
    }
  }

  function skipItem(item) {
    const previous = { status:item.status, message:item.message };
    item.status = 'skipped'; item.message = STATUS_TEXT.skipped;
    return { previous };
  }

  function removeFinished() {
    const removed = [];
    batch.items.forEach((item, index) => { if (FINISHED.includes(item.status)) removed.push({ item, index }); });
    if (!removed.length) return toast('Nothing has finished yet. Finished applications stay in the list until you remove them.');
    batch.items = batch.items.filter((item) => !FINISHED.includes(item.status));
    return removed;
  }

  $('#batch-urls').addEventListener('input', () => { const urls = validUrls(); $('#url-count').textContent = `${urls.length} valid URL${urls.length === 1 ? '' : 's'}`; });
  $('#batch-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const urls = validUrls();
    if (!urls.length) return toast('Add at least one job posting link.');
    const existing = new Set(batch.items.map((item) => item.url));
    for (const url of urls) if (!existing.has(url)) batch.items.push({ id:`job-${Date.now()}-${Math.random().toString(16).slice(2)}`, url, status:'queued', message:STATUS_TEXT.queued });
    $('#batch-urls').value = '';
    $('#url-count').textContent = '0 valid URLs';
    await persist(); render();
    runQueue();
  });
  $('#batch-list').addEventListener('click', async (event) => {
    const action = event.target.closest('button'); if (!action) return;
    const id = action.dataset.batchRetry || action.dataset.batchSkip || action.dataset.batchReview || action.dataset.batchReuse || action.dataset.batchNew;
    const item = batch.items.find((candidate) => candidate.id === id); if (!item) return;
    if (action.dataset.batchSkip) {
      const { previous } = skipItem(item);
      await persist(); render();
      return toast(`Skipped ${label(item)}.`, { label:'Undo', run: async () => { Object.assign(item, previous); await persist(); render(); } });
    }
    if (action.dataset.batchReview) {
      const tab = await browser.tabs.create({ url:item.url, active:true });
      await waitForTab(tab.id);
      try {
        const response = await browser.tabs.sendMessage(tab.id, { type:'START_AUTOFILL' });
        if (response?.status !== 'started') throw new Error('AutoApply did not start');
      } catch (_) {
        item.message = 'AutoApply couldn’t start on this page. Reload it and try again.';
        await persist(); render();
        toast(item.message);
      }
      return;
    }
    if (action.dataset.batchReuse) {
      const response = await browser.runtime.sendMessage({ type:'OPEN_WORKSPACE_RECORD', opportunity_id:item.existingId });
      if (response?.status !== 'success') return toast('AutoApply couldn’t open the saved application. Try again.');
      item.status = 'reused'; item.opportunityId = item.existingId; item.message = 'Opened the application you already saved'; await persist(); return render();
    }
    if (action.dataset.batchNew) return prepareItem(item, 'create_new');
    if (action.dataset.batchRetry) {
      if (batch.running) return toast('AutoApply is still working through the list. Try again when it finishes.');
      return prepareItem(item);
    }
  });
  $('#clear-complete').addEventListener('click', async () => {
    const removed = removeFinished();
    if (!removed) return;
    await persist(); render();
    const count = removed.length;
    toast(`Removed ${count} finished ${count === 1 ? 'application' : 'applications'}.`, {
      label:'Undo',
      run: async () => {
        for (const { item, index } of removed) batch.items.splice(Math.min(index, batch.items.length), 0, item);
        await persist(); render();
        toast(`Put ${count} finished ${count === 1 ? 'application' : 'applications'} back.`);
      },
    });
  });
  $('#open-workspace').addEventListener('click', async () => browser.tabs.create({ url:`${await UTILS.getApiBase()}/dashboard#applications` }));
  $('#theme-select').addEventListener('change', async (event) => {
    themePreference = themeChoices.has(event.currentTarget.value) ? event.currentTarget.value : 'system';
    applyTheme();
    await browser.storage.local.set({ [THEME_KEY]:themePreference });
  });
  colorScheme.addEventListener('change', () => { if (themePreference === 'system') applyTheme(); });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[THEME_KEY]) {
      themePreference = themeChoices.has(changes[THEME_KEY].newValue) ? changes[THEME_KEY].newValue : 'system';
      applyTheme();
    }
  });
  initializeTheme();
  restore().then(runQueue);
});
