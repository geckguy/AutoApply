document.addEventListener('DOMContentLoaded', () => {
  const UTILS = window.__autoapply_utils;
  const $ = (selector) => document.querySelector(selector);
  const THEME_KEY = 'autoapply_theme';
  const themeOrder = ['system', 'light', 'dark'];
  const colorScheme = window.matchMedia('(prefers-color-scheme: dark)');
  let themePreference = 'system';
  let backendReady = false;
  let profileReady = false;
  let aiReady = false;
  let pageReady = false;
  let activeTab = null;
  let apiBase = '';

  function setBackendNote(text, isError) {
    const note = $('#backend-note');
    note.textContent = text;
    note.className = isError ? 'backend-note error' : 'backend-note';
  }

  function applyApiBase(base) {
    apiBase = base;
    $('#backend-base').value = base;
    const port = new URL(base).port || '80';
    $('#offline-command').innerHTML = port === '8000'
      ? 'source backend/venv/bin/activate<br>python -m backend.main'
      : `source backend/venv/bin/activate<br>uvicorn backend.main:app --port ${port}`;
    $('#offline-copy').textContent = `Your profile stays local; the extension only talks to ${base}.`;
    setBackendNote(`AutoApply talks to ${base}.`, false);
  }

  async function initializeApiBase() {
    applyApiBase(await UTILS.getApiBase());
  }

  function resolvedTheme() {
    return themePreference === 'system' ? (colorScheme.matches ? 'dark' : 'light') : themePreference;
  }

  function applyTheme() {
    document.documentElement.dataset.theme = resolvedTheme();
    const label = themePreference[0].toUpperCase() + themePreference.slice(1);
    $('#theme-toggle small').textContent = label;
    $('#theme-toggle').setAttribute('aria-label', `Color theme: ${label}`);
  }

  async function initializeTheme() {
    const saved = await browser.storage.local.get(THEME_KEY);
    themePreference = themeOrder.includes(saved[THEME_KEY]) ? saved[THEME_KEY] : 'system';
    applyTheme();
  }

  function setReadiness(id, ready, title, detail) {
    const row = $(id);
    row.className = `readiness-row ${ready ? 'ready' : 'error'}`;
    row.querySelector('strong').textContent = title;
    row.querySelector('small').textContent = detail;
  }

  function looksLikeApplication(url, title = '') {
    if (!/^https?:/i.test(url || '')) return false;
    const value = `${url} ${title}`.toLowerCase();
    return /(workdayjobs|greenhouse|lever\.co|ashbyhq|icims|smartrecruiters|taleo|oraclecloud|darwinbox|keka|\/apply(?:\/|\?|$)|application)/.test(value);
  }

  async function inspectPage() {
    try {
      [activeTab] = await browser.tabs.query({ active:true, currentWindow:true });
      pageReady = looksLikeApplication(activeTab?.url, activeTab?.title);
      $('#page-title').textContent = pageReady ? (activeTab.title || 'Application page').replace(/\s[-|].*$/, '').slice(0, 62) : 'No application detected';
      $('#page-copy').textContent = pageReady ? 'Prepare fields and review anything uncertain before filling.' : 'Open a job application page, then return here.';
    } catch (_) {
      $('#page-title').textContent = 'This tab is unavailable';
      $('#page-copy').textContent = 'Open a regular job application page and try again.';
    }
    updatePrimaryAction();
  }

  async function inspectBackend() {
    try {
      const health = await UTILS.apiCall('/api/health');
      backendReady = health.status === 'healthy';
      profileReady = Boolean(health.profile_loaded && health.resume_uploaded);
      aiReady = Boolean(health.ai_ready);
      $('#backend-status').className = 'status ready';
      $('#backend-status span').textContent = 'Connected';
      setReadiness('#ready-backend', true, 'Local backend', `Connected to ${apiBase}`);
      setReadiness('#ready-profile', profileReady, 'Profile & resume', profileReady ? 'Ready to reuse' : 'Upload and verify your resume');
      setReadiness('#ready-ai', aiReady, 'AI provider', aiReady ? `${health.ai_provider} · ${health.ai_model}` : (health.ai_error || 'Add a provider key in backend/.env'));
      $('#offline-help').hidden = true;
    } catch (_) {
      backendReady = profileReady = aiReady = false;
      $('#backend-status').className = 'status error';
      $('#backend-status span').textContent = 'Offline';
      setReadiness('#ready-backend', false, 'Local backend', `Start the service at ${apiBase}`);
      setReadiness('#ready-profile', false, 'Profile & resume', 'Available after the backend starts');
      setReadiness('#ready-ai', false, 'AI provider', 'Available after the backend starts');
      $('#offline-help').hidden = false;
    }
    updatePrimaryAction();
  }

  function updatePrimaryAction() {
    const button = $('#prepare-btn');
    button.disabled = !(backendReady && profileReady && pageReady);
    if (!backendReady) button.innerHTML = 'Start the local backend<span>Then return to this application page</span>';
    else if (!profileReady) button.innerHTML = 'Finish profile setup<span>A resume and contact details are required</span>';
    else if (!pageReady) button.innerHTML = 'Open an application page<span>AutoApply will wait here</span>';
    else if (!aiReady) button.innerHTML = 'Prepare application<span>Local answers only · AI suggestions are unavailable</span>';
    else button.innerHTML = 'Prepare application<span>Review before anything is filled</span>';
  }

  $('#prepare-btn').addEventListener('click', async () => {
    if (!activeTab?.id) return;
    $('#prepare-btn').disabled = true;
    $('#prepare-btn').innerHTML = 'Preparing…<span>Scanning fields and building your review</span>';
    try {
      const response = await browser.runtime.sendMessage({ type:'START_AUTOFILL' });
      if (response?.status !== 'success') throw new Error(response?.error || 'AutoApply could not start on this tab.');
      window.close();
    } catch (error) {
      $('#page-copy').textContent = `AutoApply could not access this tab (${error.message}). Reload the page and try again.`;
      updatePrimaryAction();
    }
  });

  $('#backend-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      applyApiBase(await UTILS.setApiBase($('#backend-base').value));
      setBackendNote(`Saved. AutoApply now talks to ${apiBase}.`, false);
      await inspectBackend();
    } catch (error) {
      setBackendNote(error.message, true);
    }
  });

  const openUrl = (url) => browser.tabs.create({ url });
  const openDashboard = async (path) => openUrl(`${await UTILS.getApiBase()}${path}`);
  $('#open-workspace').addEventListener('click', () => openDashboard('/dashboard'));
  $('#open-setup').addEventListener('click', () => openDashboard('/dashboard#profile'));
  $('#open-batch').addEventListener('click', () => openUrl(browser.runtime.getURL('popup/batch.html')));
  $('#theme-toggle').addEventListener('click', async () => {
    themePreference = themeOrder[(themeOrder.indexOf(themePreference) + 1) % themeOrder.length];
    applyTheme();
    await browser.storage.local.set({ [THEME_KEY]:themePreference });
  });
  colorScheme.addEventListener('change', () => { if (themePreference === 'system') applyTheme(); });
  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local') return;
    if (changes[THEME_KEY]) {
      themePreference = themeOrder.includes(changes[THEME_KEY].newValue) ? changes[THEME_KEY].newValue : 'system';
      applyTheme();
    }
    const storedBase = await UTILS.getApiBase();
    if (storedBase !== apiBase) {
      applyApiBase(storedBase);
      await inspectBackend();
    }
  });
  initializeTheme();
  inspectPage();
  initializeApiBase().then(inspectBackend);
});
