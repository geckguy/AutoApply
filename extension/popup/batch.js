document.addEventListener('DOMContentLoaded', () => {
  const UTILS = window.__autoapply_utils;
  const STORAGE_KEY = 'autoapply_batch_preparation_v2';
  const THEME_KEY = 'autoapply_theme';
  const themeChoices = new Set(['system', 'light', 'dark']);
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  const $ = (selector) => document.querySelector(selector);
  let batch = { items:[], running:false };
  let themePreference = 'system';

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
  function toast(message) { $('#toast').textContent = message; $('#toast').className = 'toast show'; clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').className = 'toast'; }, 3200); }
  async function persist() { await browser.storage.local.set({ [STORAGE_KEY]:batch }); }
  async function restore() { const saved = await browser.storage.local.get(STORAGE_KEY); if (saved[STORAGE_KEY]) batch = { ...saved[STORAGE_KEY], running:false }; render(); }
  function host(url) { try { return new URL(url).hostname.replace(/^www\./,''); } catch (_) { return url; } }

  function render() {
    const complete = batch.items.filter((item) => ['ready','reused'].includes(item.status)).length;
    const active = batch.items.filter((item) => ['queued','running'].includes(item.status)).length;
    $('#batch-summary').innerHTML = `<span>${batch.running ? 'Preparing in the background' : active ? 'Ready to continue' : 'Queue status'}</span><strong>${complete}/${batch.items.length} prepared</strong>`;
    $('#batch-list').innerHTML = batch.items.length ? batch.items.map((item) => `<article class="batch-row ${item.status}"><i></i><div><strong>${item.title || host(item.url)}</strong><small>${item.message || item.status.replace('_',' ')}</small></div><div class="row-actions">${item.status === 'duplicate' ? `<button data-batch-reuse="${item.id}">Open tracked</button><button data-batch-new="${item.id}">Prepare another</button>` : ''}${item.status === 'failed' ? `<button data-batch-retry="${item.id}">Retry</button><button data-batch-skip="${item.id}">Skip</button>` : ''}${['ready','reused'].includes(item.status) ? `<button data-batch-review="${item.id}">Review</button>` : ''}</div></article>`).join('') : '<div class="empty">Paste URLs to begin. This page can stay open while AutoApply works in the background.</div>';
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
      if (result.status === 'duplicate') {
        item.status = 'duplicate'; item.matches = result.matches || []; item.existingId = item.matches[0]?.id || null;
        item.title = result.title || item.title; item.message = 'Possible duplicate — choose how to continue';
      } else {
        item.status = result.reused ? 'reused' : 'ready'; item.opportunityId = result.opportunity_id;
        item.title = result.title || item.title; item.message = `${result.ready_count || 0} ready · ${result.review_count || 0} need review${typeof result.fit_score === 'number' ? ` · ${result.fit_score}% fit` : ''}`;
      }
    } catch (error) {
      item.status = 'failed'; item.message = error.message || 'Preparation failed';
    } finally {
      if (tab?.id) await browser.tabs.remove(tab.id).catch(() => {});
      await persist(); render();
    }
  }

  async function runQueue() {
    if (batch.running) return;
    batch.running = true; await persist(); render();
    for (const item of batch.items) if (item.status === 'queued') await prepareItem(item);
    batch.running = false; await persist(); render();
  }

  $('#batch-urls').addEventListener('input', () => { const urls = validUrls(); $('#url-count').textContent = `${urls.length} valid URL${urls.length === 1 ? '' : 's'}`; });
  $('#batch-form').addEventListener('submit', async (event) => { event.preventDefault(); const urls = validUrls(); if (!urls.length) return toast('Add at least one valid http or https URL.'); const existing = new Set(batch.items.map((item) => item.url)); for (const url of urls) if (!existing.has(url)) batch.items.push({ id:`job-${Date.now()}-${Math.random().toString(16).slice(2)}`, url, status:'queued', message:'Waiting to prepare' }); $('#batch-urls').value = ''; $('#url-count').textContent = '0 valid URLs'; await persist(); render(); runQueue(); });
  $('#batch-list').addEventListener('click', async (event) => {
    const action = event.target.closest('button'); if (!action) return;
    const id = action.dataset.batchRetry || action.dataset.batchSkip || action.dataset.batchReview || action.dataset.batchReuse || action.dataset.batchNew;
    const item = batch.items.find((candidate) => candidate.id === id); if (!item) return;
    if (action.dataset.batchSkip) { item.status = 'skipped'; item.message = 'Skipped'; await persist(); return render(); }
    if (action.dataset.batchReview) { const tab = await browser.tabs.create({ url:item.url, active:true }); await waitForTab(tab.id); await browser.tabs.sendMessage(tab.id, { type:'START_AUTOFILL' }).catch(() => {}); return; }
    if (action.dataset.batchReuse) {
      const response = await browser.runtime.sendMessage({ type:'OPEN_WORKSPACE_RECORD', opportunity_id:item.existingId });
      if (response?.status !== 'success') return toast(response?.error || 'Could not open the tracked application.');
      item.status = 'reused'; item.opportunityId = item.existingId; item.message = 'Opened the existing tracked application'; await persist(); return render();
    }
    if (action.dataset.batchNew) return prepareItem(item, 'create_new');
    if (action.dataset.batchRetry) return prepareItem(item);
  });
  $('#clear-complete').addEventListener('click', async () => { batch.items = batch.items.filter((item) => !['ready','reused','skipped'].includes(item.status)); await persist(); render(); });
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
