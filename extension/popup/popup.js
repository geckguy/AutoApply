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
    setBackendNote('AutoApply is set up to talk to the app on this computer.', false);
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

  /** state is 'ready', 'error' (required and missing) or 'neutral' (optional). */
  function setReadiness(id, state, title, detail) {
    const row = $(id);
    row.className = `readiness-row ${state}`;
    row.querySelector('strong').textContent = title;
    row.querySelector('small').textContent = detail;
  }

  /** Known application platforms. A fast path; the page itself is asked next. */
  function looksLikeApplication(url, title = '') {
    if (!/^https?:/i.test(url || '')) return false;
    const value = `${url} ${title}`.toLowerCase();
    return /(workdayjobs|greenhouse|lever\.co|ashbyhq|icims|smartrecruiters|taleo|oraclecloud|darwinbox|keka|\/apply(?:\/|\?|$)|application)/.test(value);
  }

  /**
   * Ask the page whether it holds a fillable form. The content script owns that
   * check, so the popup and the on-page prompt agree on one verdict.
   */
  async function pageHasApplicationForm(tabId) {
    if (!tabId) return false;
    try {
      const answer = await browser.tabs.sendMessage(tabId, { type:'AA_DETECT_APPLICATION' });
      return answer?.detected === true;
    } catch (_) {
      return false;
    }
  }

  async function inspectPage() {
    try {
      [activeTab] = await browser.tabs.query({ active:true, currentWindow:true });
      pageReady = looksLikeApplication(activeTab?.url, activeTab?.title) || await pageHasApplicationForm(activeTab?.id);
      const pageName = (activeTab?.title || '').replace(/\s[-|].*$/, '').slice(0, 62);
      $('#page-title').textContent = pageReady ? (pageName || 'Application page') : 'Nothing here looked like an application form';
      $('#page-copy').textContent = pageReady
        ? 'Review anything uncertain before it is filled.'
        : 'If this page has a form, prepare it anyway. You can review everything before it is filled.';
    } catch (_) {
      $('#page-title').textContent = 'This tab cannot be read';
      $('#page-copy').textContent = 'Open the job application in a regular browser tab and try again.';
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
      setReadiness('#ready-backend', 'ready', 'AutoApply app', 'Connected on this computer');
      setReadiness('#ready-profile', profileReady ? 'ready' : 'error', 'Profile & resume', profileReady ? 'Ready to reuse' : 'Add your resume and contact details');
      setReadiness('#ready-ai', aiReady ? 'ready' : 'neutral', 'AI service', aiReady ? 'Connected' : 'Not set up — review suggestions will be unavailable');
      $('#offline-help').hidden = true;
    } catch (_) {
      backendReady = profileReady = aiReady = false;
      $('#backend-status').className = 'status error';
      $('#backend-status span').textContent = 'Not running';
      setReadiness('#ready-backend', 'error', 'AutoApply app', 'Can’t reach AutoApply. Start it on this computer');
      setReadiness('#ready-profile', 'error', 'Profile & resume', 'AutoApply can’t check this until it is running');
      setReadiness('#ready-ai', 'neutral', 'AI service', 'AutoApply can’t check this until it is running');
      $('#offline-help').hidden = false;
    }
    updatePrimaryAction();
  }

  /**
   * The page never blocks the primary action: when nothing looks like an
   * application, the same button still starts the flow on the current page.
   */
  function updatePrimaryAction() {
    const button = $('#prepare-btn');
    button.disabled = !(backendReady && profileReady);
    if (!backendReady) button.innerHTML = 'Start AutoApply<span>Then come back to this page</span>';
    else if (!profileReady) button.innerHTML = 'Add your resume and details<span>AutoApply needs them before it can prepare</span>';
    else if (!pageReady) button.innerHTML = 'Prepare this page anyway<span>AutoApply will look for a form here</span>';
    else if (!aiReady) button.innerHTML = 'Prepare application<span>Saved details still fill in</span>';
    else button.innerHTML = 'Prepare application<span>Review before anything is filled</span>';
  }

  $('#prepare-btn').addEventListener('click', async () => {
    if (!activeTab?.id) return;
    $('#prepare-btn').disabled = true;
    $('#prepare-btn').innerHTML = 'Preparing…<span>Looking for the form and building your review</span>';
    try {
      const response = await browser.runtime.sendMessage({ type:'START_AUTOFILL' });
      if (response?.status !== 'success') throw new Error('AutoApply did not start');
      window.close();
    } catch (_) {
      $('#page-copy').textContent = 'AutoApply couldn’t start on this page. Reload the page and try again.';
      updatePrimaryAction();
    }
  });

  $('#backend-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      applyApiBase(await UTILS.setApiBase($('#backend-base').value));
      setBackendNote('Saved. AutoApply will use this address.', false);
      await inspectBackend();
    } catch (_) {
      $('#app-address').open = true;
      setBackendNote('That address didn’t work. Copy the address from the AutoApply app on this computer.', true);
    }
  });

  const openUrl = (url) => browser.tabs.create({ url });
  const openDashboard = async (path) => openUrl(`${await UTILS.getApiBase()}${path}`);
  $('#open-workspace').addEventListener('click', () => openDashboard('/dashboard'));
  $('#open-setup').addEventListener('click', () => openDashboard('/dashboard#profile'));
  $('#open-setup-card').addEventListener('click', () => openDashboard('/dashboard#profile'));
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
