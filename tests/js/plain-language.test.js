#!/usr/bin/env node

/*
 * Plain-language contract for user-visible copy.
 *
 * The product is for non-technical job seekers: they know browsers, tabs and
 * PDFs, not terminals, environment variables, ports, HTTP codes or internal
 * concepts like "workspace" and "backend". This test is the guard that stops
 * the jargon creeping back in after the copy pass that removed it.
 *
 * How it works: it scans lines that render text to the user (innerHTML,
 * textContent, toasts, status banners, aria-labels, placeholders) and extracts
 * the string literals on those lines. Only literals containing a space are
 * checked, because user-facing copy is prose while selectors ('#foo'),
 * identifiers ('API_CALL_PROXY') and storage keys ('autoapply-theme') are not.
 *
 * Deliberate limitation: a single-word user-visible string would pass. This is
 * a regression guard for the vocabulary that was removed, not a proof that
 * every string is plain.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** Lines that put text in front of the user. */
const RENDER_TRIGGERS = [
  '.innerHTML',
  'insertAdjacentHTML',
  '.textContent =',
  '.textContent=',
  "setAttribute('aria-label'",
  'setAttribute("aria-label"',
  'placeholder=',
  'toast(',
  'showStatus(',
  'showError(',
  'setReadiness(',
  'setBackendNote(',
  'document.title',
];

/** Terms that must never reach a user, with the replacement used instead. */
const BANNED = [
  { pattern: /backend/i, instead: '"AutoApply" or "the AutoApply app"' },
  { pattern: /workspace/i, instead: '"your applications"' },
  { pattern: /\.env\b/, instead: '"Finish setup in AutoApply"' },
  { pattern: /loopback/i, instead: '"this computer"' },
  { pattern: /autopilot/i, instead: '"Auto-run"' },
  { pattern: /\bconsole\b/i, instead: 'a plain next step' },
  { pattern: /\bHTTP\b/, instead: 'a plain sentence' },
  { pattern: /API error/i, instead: 'a plain sentence' },
  { pattern: /fit analysis|%\s*fit/i, instead: '"match score"' },
  { pattern: /answer vault/i, instead: '"saved answers"' },
  { pattern: /autofill guardrails|review policy/i, instead: '"fill rules"' },
  { pattern: /export csv/i, instead: '"export spreadsheet"' },
];

/** Extract string literals from one source line. */
function literalsOn(line) {
  const found = [];
  const patterns = [
    /'([^'\\]*(?:\\.[^'\\]*)*)'/g,
    /"([^"\\]*(?:\\.[^"\\]*)*)"/g,
    /`([^`\\]*(?:\\.[^`\\]*)*)`/g,
  ];
  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/** A literal is user-facing prose when it contains a space and is not a selector. */
function isProse(literal) {
  if (!/\s/.test(literal)) return false;
  if (/^[#./]/.test(literal.trim())) return false;
  return true;
}

/**
 * Strip markup and URLs before checking a literal: a template literal that
 * builds a row contains both the prose a user reads and the API path it links
 * to, and only the prose is subject to the vocabulary rule.
 */
function visibleText(literal) {
  return literal
    .replace(/<[^>]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\/[A-Za-z0-9_${}.:%-]*/g, ' ');
}

const RENDERED_FILES = [
  'extension/content/overlay.js',
  'extension/popup/popup.js',
  'extension/popup/batch.js',
  'backend/dashboard/dashboard.js',
];

let failures = 0;

for (const file of RENDERED_FILES) {
  const lines = read(file).split('\n');
  lines.forEach((line, index) => {
    if (!RENDER_TRIGGERS.some((trigger) => line.includes(trigger))) return;
    for (const literal of literalsOn(line)) {
      if (!isProse(literal)) continue;
      const prose = visibleText(literal);
      for (const { pattern, instead } of BANNED) {
        if (pattern.test(prose)) {
          failures += 1;
          console.error(
            `${file}:${index + 1}: user-visible copy matches ${pattern} -> use ${instead}\n` +
            `    ${literal.trim()}`
          );
        }
      }
    }
  });
}

assert.equal(failures, 0, `${failures} user-visible string(s) still use internal vocabulary`);

/*
 * A non-technical user cannot run a shell command, so no surface may print one.
 * The launcher scripts are excluded: they ARE the shell, and that is their job.
 */
for (const file of ['extension/popup/popup.html', 'backend/dashboard/index.html']) {
  const html = read(file);
  for (const command of ['venv', 'python -m', 'uvicorn', 'source backend']) {
    assert.ok(
      !html.includes(command),
      `${file} must not show the user a shell command (found "${command}")`,
    );
  }
}

/*
 * The locality claim. AutoApply keeps the profile, applications and workspace on
 * disk, but resume text and job descriptions go to the chosen AI service, so a
 * blanket "your data stays on this computer" is false. The disclosure must be
 * present wherever the promise used to be.
 */
assert.ok(
  !read('backend/dashboard/index.html').includes('your data stays on this computer'),
  'the dashboard must not claim all data stays on this computer',
);
assert.match(
  read('extension/popup/popup.html'),
  /sent to the AI service/i,
  'the popup must disclose that resume and job details go to the AI service',
);

/* "scrapes" is the word most likely to make a privacy-conscious user stop. */
for (const manifest of ['extension/manifest.json', 'extension-chrome/manifest.json']) {
  const parsed = JSON.parse(read(manifest));
  assert.ok(
    !/scrape/i.test(parsed.description || ''),
    `${manifest} description must not say "scrape"`,
  );
}

console.log('plain-language contract checks passed');
