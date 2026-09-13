#!/usr/bin/env node

/*
 * Packaging invariants that a plausible mistake would break: every file the
 * manifests load or point at must exist, and the shipped SVGs must be
 * well-formed with the viewBox the icon set uses.
 *
 * Byte-level parity between the two browser trees and between the manifests is
 * enforced by scripts/sync-extension.sh --check, which scripts/check.sh runs;
 * it is deliberately not re-implemented here.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** Every file a manifest package loads or links to. */
function referencedFiles(manifest) {
  const files = [];
  const action = manifest.action || manifest.browser_action || {};

  files.push(...Object.values(manifest.icons || {}));
  files.push(...Object.values(action.default_icon || {}));
  if (action.default_popup) files.push(action.default_popup);

  for (const entry of manifest.content_scripts || []) {
    files.push(...(entry.js || []), ...(entry.css || []));
  }
  for (const resource of manifest.web_accessible_resources || []) {
    if (typeof resource === 'string') files.push(resource);
    else files.push(...(resource.resources || []));
  }

  const background = manifest.background || {};
  files.push(...(background.scripts || []));
  if (background.service_worker) files.push(background.service_worker);

  return [...new Set(files)];
}

for (const tree of ['extension', 'extension-chrome']) {
  const manifest = JSON.parse(read(`${tree}/manifest.json`));
  const files = referencedFiles(manifest);
  assert.ok(files.length >= 6, `${tree}: manifest references its icon, popup, content scripts and background`);

  for (const file of files) {
    const absolute = path.join(root, tree, file);
    assert.ok(fs.existsSync(absolute), `${tree}: manifest references ${file}, which must exist`);
    assert.ok(fs.statSync(absolute).size > 0, `${tree}: manifest-referenced ${file} must not be empty`);
  }

  for (const icon of Object.values(manifest.icons || {})) {
    const svg = read(`${tree}/${icon}`);
    assert.match(svg, /^<svg[\s\S]*<\/svg>\s*$/, `${tree}/${icon} must be a well-formed SVG document`);
    assert.match(svg, /viewBox="0 0 48 48"/, `${tree}/${icon} must keep the icon set's 48x48 viewBox`);
  }
}

const dashboardLogo = read('backend/dashboard/logo.svg');
assert.match(dashboardLogo, /^<svg[\s\S]*<\/svg>\s*$/, 'backend/dashboard/logo.svg must be a well-formed SVG document');
assert.match(dashboardLogo, /viewBox="0 0 48 48"/, 'backend/dashboard/logo.svg must keep its 48x48 viewBox');

console.log('usability workflow contract checks passed');
