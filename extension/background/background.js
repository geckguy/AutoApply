/**
 * AutoApply — Background Script
 * Handles extension state tracking and message routing between components.
 */

// Track global extension state
let extensionState = {
  status: 'idle', // idle, scanning, filling, reviewing, complete
  lastActiveTabId: null,
  todayCount: 0
};

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
    extensionState.todayCount = (extensionState.todayCount || 0) + 1;
    showNotification(
      'Application Logged',
      `Applied to ${message.data.role} at ${message.data.company}. Total today: ${extensionState.todayCount}`
    );
    sendResponse({ status: 'success' });
    return false;
  }

  if (message.type === 'START_AUTOFILL') {
    // Query active tab in the current window
    browser.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (tabs && tabs[0]) {
          const tabId = tabs[0].id;
          extensionState.status = 'scanning';
          extensionState.lastActiveTabId = tabId;
          
          // Send message to the tab's content script
          return browser.tabs.sendMessage(tabId, { type: 'START_AUTOFILL' });
        } else {
          throw new Error('No active tab found.');
        }
      })
      .then((response) => {
        extensionState.status = 'reviewing';
        sendResponse({ status: 'success', details: response });
      })
      .catch((err) => {
        console.error('[AutoApply Background] Error starting autofill:', err);
        extensionState.status = 'idle';
        sendResponse({ status: 'error', error: err.message });
      });
      
    return true; // Keep connection open for async sendResponse
  }

  if (message.type === 'GET_STATUS') {
    sendResponse(extensionState);
    return false;
  }

  if (message.type === 'SET_STATUS') {
    extensionState.status = message.status;
    sendResponse({ status: 'updated' });
    return false;
  }

  if (message.type === 'GET_RECENT_APPS') {
    // Route API fetch through background to avoid potential CORS issues in popup contexts
    fetch('http://localhost:8000/api/applications/?limit=5', { signal: AbortSignal.timeout(30000) })
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

  if (message.type === 'API_CALL_PROXY') {
    const url = `http://localhost:8000${message.endpoint}`;
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

    fetch(url, options)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`API error ${res.status}: ${text}`);
        }
        return res.json();
      })
      .then((data) => sendResponse({ status: 'success', data }))
      .catch((err) => sendResponse({ status: 'error', error: err.message }));

    return true; // Keep connection open
  }
});

// Listen for keyboard shortcut commands
browser.commands.onCommand.addListener((command) => {
  if (command === 'toggle-autofill') {
    console.log('[AutoApply Background] Keyboard shortcut triggered: toggle-autofill');
    browser.tabs.query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (tabs && tabs[0]) {
          const tabId = tabs[0].id;
          extensionState.status = 'scanning';
          extensionState.lastActiveTabId = tabId;
          return browser.tabs.sendMessage(tabId, { type: 'START_AUTOFILL' });
        }
      })
      .then(() => {
        extensionState.status = 'reviewing';
      })
      .catch((err) => {
        console.error('[AutoApply Background] Keyboard shortcut error:', err);
        extensionState.status = 'idle';
      });
  }
});

console.log('[AutoApply Background] Service worker loaded.');
