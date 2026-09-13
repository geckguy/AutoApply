#!/usr/bin/env node

/*
 * The browser side and the backend must agree on the workspace API.
 *
 * This test asserts the real client call sites — path AND HTTP method — in the
 * extension source, and drives the shared `workspaceCall()` helper to prove the
 * URL the backend has to serve. It deliberately does not read WORKSPACE_API.md:
 * the documentation alone must never satisfy a contract check.
 *
 * Byte-level parity between the two browser trees is owned by
 * scripts/sync-extension.sh --check, so the canonical `extension/` tree is the
 * one read here.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { createContext, loadScripts } = require(path.join(root, 'tests', 'js', 'fake-dom.js'));

const overlay = read('extension/content/overlay.js');
const background = read('extension/background/background.js');

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every workspace endpoint the flow depends on, with the method the client
// uses. GET is workspaceCall()'s default, so the call may omit it.
const WORKSPACE_CALLS = [
  { endpoint: '/resume-versions', method: 'GET' },
  { endpoint: '/opportunities/upsert', method: 'POST' },
  { endpoint: '/application-packets', method: 'POST' },
  { endpoint: '/teaches', method: 'POST' },
  { endpoint: '/submissions/confirm', method: 'POST' },
];

for (const { endpoint, method } of WORKSPACE_CALLS) {
  const quoted = escapeRegExp(`'${endpoint}'`);
  const pattern = method === 'GET'
    ? new RegExp(`workspaceCall\\(${quoted}\\s*\\)`)
    : new RegExp(`workspaceCall\\(${quoted},\\s*'${method}'`);
  assert.match(overlay, pattern, `overlay.js must call ${method} ${endpoint} through workspaceCall()`);
}

// The backend API itself, same shape of check.
const API_CALLS = [
  { endpoint: '/api/autofill', method: 'POST' },
  { endpoint: '/api/analyze-job', method: 'POST' },
  { endpoint: '/api/cover-letter', method: 'POST' },
  { endpoint: '/api/corrections', method: 'POST' },
];

for (const { endpoint, method } of API_CALLS) {
  assert.match(
    overlay,
    new RegExp(`apiCall\\('${escapeRegExp(endpoint)}',\\s*'${method}'`),
    `overlay.js must call ${method} ${endpoint} through apiCall()`,
  );
}

assert.match(
  background,
  /\/api\/workspace\/resume-versions\/\$\{encodeURIComponent\(versionId\)\}\/download/,
  'background.js must download a resume version from the workspace API',
);

// The overlay passes workspace-relative paths; the shared helper composes the
// /api/workspace prefix the backend serves. Driving it proves the full URL.
async function main() {
  const calls = [];
  const { context } = createContext();
  context.browser = {
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        return { status: 'success', data: null };
      },
    },
  };
  loadScripts(context, root, ['extension/lib/utils.js']);
  const utils = context.window.__autoapply_utils;

  const body = { question: 'Why this role?' };
  await utils.workspaceCall('/teaches', 'POST', body);
  assert.deepEqual(
    { ...calls[0] },
    { type: 'API_CALL_PROXY', endpoint: '/api/workspace/teaches', method: 'POST', body },
    'workspaceCall() must POST workspace-relative paths under /api/workspace',
  );

  await utils.workspaceCall('/resume-versions');
  assert.deepEqual(
    { ...calls[1] },
    { type: 'API_CALL_PROXY', endpoint: '/api/workspace/resume-versions', method: 'GET', body: null },
    'workspaceCall() must default to GET under /api/workspace',
  );

  console.log('workspace contract checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
