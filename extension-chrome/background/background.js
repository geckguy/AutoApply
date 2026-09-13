/**
 * AutoApply — Background Script
 * Handles extension state tracking and message routing between components.
 */

if (typeof browser === 'undefined') {
  globalThis.browser = chrome;
}


// MV2 loads lib/utils.js through the manifest; MV3 service workers load it here.
if (typeof importScripts === 'function') importScripts('../lib/utils.js');

const STATE_STORAGE_KEY = 'extensionState';
const MAX_RESUME_BYTES = 10 * 1024 * 1024;

// MV3 service workers are evicted after ~30s idle, so the day-stamped counter
// and the status live in browser.storage.local instead of module scope.
function normalizeExtensionState(stored) {
  const state = stored && typeof stored === 'object' ? stored : {};
  const todayKey = new Date().toDateString();
  return {
    status: typeof state.status === 'string' ? state.status : 'idle',
    lastActiveTabId: Number.isInteger(state.lastActiveTabId) ? state.lastActiveTabId : null,
    todayKey,
    todayCount: state.todayKey === todayKey && Number.isInteger(state.todayCount) ? state.todayCount : 0
  };
}

async function readExtensionState() {
  const stored = await browser.storage.local.get(STATE_STORAGE_KEY);
  return normalizeExtensionState(stored ? stored[STATE_STORAGE_KEY] : null);
}

// Serialize read-modify-write cycles so concurrent events cannot lose an update.
let stateWriteChain = Promise.resolve();
function mutateExtensionState(mutate) {
  const run = stateWriteChain.then(async () => {
    const next = await mutate(await readExtensionState());
    await browser.storage.local.set({ [STATE_STORAGE_KEY]: next });
    return next;
  });
  stateWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

function updateExtensionState(patch) {
  return mutateExtensionState((state) => ({ ...state, ...patch }));
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fileNameFromDisposition(value) {
  const match = /filename\*?=(?:UTF-8''|\")?([^\";]+)/i.exec(value || '');
  if (!match) return 'resume.pdf';
  try {
    return decodeURIComponent(match[1].replace(/\"/g, '')).replace(/[\\/]/g, '_');
  } catch (_) {
    return 'resume.pdf';
  }
}

async function fetchResumeVersion(versionId) {
  if (typeof versionId !== 'string' || !versionId.trim()) {
    throw new Error('Choose a resume version before attaching it.');
  }
  const base = await AutoApplyUtils.getApiBase();
  const response = await fetch(
    `${base}/api/workspace/resume-versions/${encodeURIComponent(versionId)}/download`,
    { signal: AbortSignal.timeout(30000) }
  );
  if (!response.ok) throw new Error(`Resume download failed (${response.status}).`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESUME_BYTES) throw new Error('Selected resume is larger than 10MB.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_RESUME_BYTES) {
    throw new Error('Selected resume is empty or larger than 10MB.');
  }
  return {
    base64: bytesToBase64(bytes),
    filename: fileNameFromDisposition(response.headers.get('content-disposition')),
    contentType: response.headers.get('content-type') || 'application/pdf',
    size: bytes.length,
  };
}

async function startAutofillOnActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs || !tabs[0]) throw new Error('No active tab found.');
  await updateExtensionState({ status: 'scanning', lastActiveTabId: tabs[0].id });
  try {
    const response = await browser.tabs.sendMessage(tabs[0].id, { type: 'START_AUTOFILL' });
    await updateExtensionState({ status: 'reviewing' });
    return response;
  } catch (error) {
    await updateExtensionState({ status: 'idle' });
    throw error;
  }
}

function showNotification(title, message) {
  browser.notifications.create({
    type: 'basic',
    title: title,
    message: message,
    iconUrl: browser.runtime.getURL('icons/icon-96.svg')
  });
}

// Listen for messages from popup or content scripts
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AutoApply Background] Received message:', message);

  if (message.type === 'APP_LOGGED') {
    mutateExtensionState((state) => ({ ...state, todayCount: state.todayCount + 1 }))
      .then((state) => {
        showNotification(
          'Application Logged',
          `Applied to ${message.data.role} at ${message.data.company}. Total today: ${state.todayCount}`
        );
        sendResponse({ status: 'success' });
      })
      .catch((err) => {
        console.error('[AutoApply Background] Error recording the application:', err);
        sendResponse({ status: 'error', error: err.message });
      });
    return true; // Keep connection open for async sendResponse
  }

  if (message.type === 'START_AUTOFILL') {
    startAutofillOnActiveTab()
      .then((details) => sendResponse({ status: 'success', details }))
      .catch((err) => {
        console.error('[AutoApply Background] Error starting autofill:', err);
        sendResponse({ status: 'error', error: err.message });
      });

    return true; // Keep connection open for async sendResponse
  }

  if (message.type === 'GET_STATUS') {
    readExtensionState()
      .then((state) => sendResponse(state))
      .catch((err) => sendResponse({ status: 'error', error: err.message }));
    return true;
  }

  if (message.type === 'SET_STATUS') {
    updateExtensionState({ status: message.status })
      .then(() => sendResponse({ status: 'updated' }))
      .catch((err) => sendResponse({ status: 'error', error: err.message }));
    return true;
  }

  if (message.type === 'GET_RECENT_APPS') {
    // Route API fetch through background to avoid potential CORS issues in popup contexts
    AutoApplyUtils.getApiBase()
      .then((base) => fetch(`${base}/api/applications/?limit=5`, { signal: AbortSignal.timeout(30000) }))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        return res.json();
      })
      .then((data) => {
        sendResponse({ status: 'success', data });
      })
      .catch((err) => {
        console.error('[AutoApply Background] Error fetching applications:', err);
        sendResponse({ status: 'error', error: err.message });
      });

    return true; // Keep connection open
  }

  if (message.type === 'FETCH_RESUME_VERSION') {
    fetchResumeVersion(message.version_id)
      .then((file) => sendResponse({ status: 'success', file }))
      .catch((err) => sendResponse({ status: 'error', error: err.message }));
    return true;
  }

  if (message.type === 'OPEN_WORKSPACE_RECORD') {
    const opportunityId = String(message.opportunity_id || '').trim();
    if (!opportunityId) {
      sendResponse({ status: 'error', error: 'Missing opportunity ID.' });
      return false;
    }
    AutoApplyUtils.getApiBase()
      .then((base) => browser.tabs.create({ url: `${base}/dashboard?application=${encodeURIComponent(opportunityId)}#applications` }))
      .then(() => sendResponse({ status: 'success' }))
      .catch((err) => sendResponse({ status: 'error', error: err.message }));
    return true;
  }

  if (message.type === 'API_CALL_PROXY') {
    (async () => {
      try {
        const base = await AutoApplyUtils.getApiBase();
        const options = {
          method: message.method,
          signal: AbortSignal.timeout(30000)
        };
        if (message.method !== 'GET') {
          options.headers = { 'Content-Type': 'application/json' };
          if (message.body) {
            options.body = JSON.stringify(message.body);
          }
        }

        const res = await fetch(`${base}${message.endpoint}`, options);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        sendResponse({ status: 'success', data: await res.json() });
      } catch (err) {
        sendResponse({ status: 'error', error: err.message });
      }
    })();

    return true; // Keep connection open
  }
});

// Listen for keyboard shortcut commands
browser.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-autofill') return;
  console.log('[AutoApply Background] Keyboard shortcut triggered: toggle-autofill');
  startAutofillOnActiveTab().catch((err) => {
    console.error('[AutoApply Background] Keyboard shortcut error:', err);
  });
});

console.log('[AutoApply Background] Service worker loaded.');
