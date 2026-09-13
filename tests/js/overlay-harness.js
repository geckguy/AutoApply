'use strict';

/*
 * Boots the real overlay.js in the vm harness for both extension trees.
 *
 * The overlay exposes nothing, so the tests drive it the way the browser does:
 * a background message starts the flow, the panel lives in a fake shadow root,
 * and embedded frames answer over the AA_* protocol through fake child windows.
 */

const path = require('node:path');
const { createContext, el, loadScripts } = require('./fake-dom');

const root = path.resolve(__dirname, '..', '..');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 5000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await sleep(interval);
  }
}

/** The background surface overlay.js registers against. */
function stubBrowser() {
  const listeners = [];
  return {
    listeners,
    browser: {
      runtime: {
        getURL: (file) => `chrome-extension://test/${file}`,
        onMessage: { addListener: (listener) => listeners.push(listener) },
        sendMessage: async () => ({ status: 'success' }),
      },
      storage: {
        local: { get: async () => ({}), set: async () => {} },
        onChanged: { addListener() {} },
      },
    },
  };
}

/** Replace the backend calls with canned answers; extraction stays real. */
function stubBackend(context, autofill) {
  const utils = context.window.__autoapply_utils;
  utils.apiCall = async (endpoint) => {
    if (endpoint === '/api/autofill') return autofill;
    if (endpoint === '/api/analyze-job') return { recommendation: 'unknown', score: 0 };
    return {};
  };
  utils.workspaceCall = async () => null;
  return utils;
}

function defaultFrameReply(message, frame) {
  const base = { __autoapply: true, token: message.token, frameTag: message.frameTag, ok: true };
  if (message.type === 'AA_SCRAPE' || message.type === 'AA_PROBE') {
    return {
      ...base,
      type: message.type === 'AA_PROBE' ? 'AA_PROBE_RESULT' : 'AA_SCRAPE_RESULT',
      fields: frame.fields || [],
      job_description: frame.jobDescription || '',
    };
  }
  if (message.type === 'AA_FILL') {
    return {
      ...base,
      type: 'AA_FILL_RESULT',
      results: { filled: (message.instructions || []).length, skipped: 0, failed: 0, failures: [] },
      blocking: [],
    };
  }
  if (message.type === 'AA_CLEAR') return { ...base, type: 'AA_CLEAR_RESULT' };
  return null;
}

/**
 * Boot a top-frame document. `frames` entries are { tag, fields, jobDescription,
 * reply }; the child window answers on the same dispatch as postMessage.
 */
function bootTop(tree, {
  href = 'https://job-boards.greenhouse.io/acme/jobs/1',
  title = 'Software Engineer - Acme',
  build = () => {},
  autofill = { instructions: [] },
  frames = [],
  respond = defaultFrameReply,
} = {}) {
  const handle = createContext({ href });
  const { context, document, window } = handle;
  const { browser, listeners } = stubBrowser();
  context.browser = browser;
  context.fetch = async () => ({ text: async () => '' });
  document.title = title;

  const sent = [];
  for (const [index, frame] of frames.entries()) {
    const iframe = el('iframe', {});
    document.body.appendChild(iframe);
    const frameWindow = {
      closed: false,
      frameElement: iframe,
      postMessage(message) {
        sent.push({ tag: frame.tag, message });
        const reply = respond(message, frame);
        if (reply) window.dispatchEvent({ type: 'message', data: reply, source: frameWindow });
      },
    };
    frame.window = frameWindow;
    window.frames.push(frameWindow);
  }

  build(document);
  loadScripts(context, root, [`${tree}/lib/utils.js`]);
  stubBackend(context, autofill);
  loadScripts(context, root, [
    `${tree}/content/scraper.js`,
    `${tree}/content/filler.js`,
    `${tree}/content/overlay.js`,
  ]);

  const findPanel = () => {
    const host = document.getElementById('autoapply-shadow-host');
    return host && host.shadowRoot ? host.shadowRoot.querySelector('.autoapply-overlay') : null;
  };

  return {
    ...handle,
    browser,
    listeners,
    sent,
    findPanel,
    /** Start the scan flow the way the background script does. */
    async start() {
      for (const listener of listeners) listener({ type: 'START_AUTOFILL' }, {}, () => {});
      await waitFor(() => findPanel() && findPanel().querySelector('.autoapply-primary-action-btn'));
      return findPanel();
    },
  };
}

/** Boot a child-frame document: overlay must register only the responder. */
function bootChild(tree, {
  href = 'https://jobs.example.com/embed/form',
  build = () => {},
  parent = null,
} = {}) {
  const handle = createContext({ href });
  const { context, document, window } = handle;
  const posts = [];
  const parentWindow = parent || {
    closed: false,
    postMessage(message) { posts.push(message); },
  };
  window.top = {};
  window.parent = parentWindow;
  document.title = 'Embedded application';
  build(document);
  loadScripts(context, root, [
    `${tree}/lib/utils.js`,
    `${tree}/content/scraper.js`,
    `${tree}/content/filler.js`,
    `${tree}/content/overlay.js`,
  ]);
  return { ...handle, posts, parentWindow };
}

module.exports = { bootTop, bootChild, waitFor, sleep, root };
