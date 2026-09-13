#!/usr/bin/env node

/*
 * The overlay's ready-chip retry window and the review panel's skip grouping.
 *
 * A single mount attempt 700 ms after injection missed client-rendered boards,
 * so the gate is re-read on page mutations for a bounded window; the watch must
 * end as soon as the chip mounts, a flow starts, or the user dismisses the
 * panel. On the panel side, non-required policy/unsupported skips collapse into
 * one counted summary row while a required-unfilled skip stays visible.
 */
'use strict';

const assert = require('node:assert/strict');
const { bootTop, waitFor, sleep } = require('./overlay-harness');
const { el } = require('./fake-dom');

const TREES = ['extension', 'extension-chrome'];

function chipHosts(document) {
  return document.documentElement.descendants().filter((node) => node.attributes.id === 'autoapply-ready-chip-host');
}

function chipObserver(handle) {
  return handle.observers.filter((observer) => observer.target === handle.document.body).pop() || null;
}

function addFormFields(document) {
  document.body.appendChild(el('input', { id: 'late-name', type: 'text', name: 'name' }));
  document.body.appendChild(el('input', { id: 'late-email', type: 'email', name: 'email' }));
}

function panelFields(document) {
  document.body.appendChild(el('input', { id: 'ready-name', type: 'text', name: 'name' }));
  document.body.appendChild(el('input', { id: 'ready-email', type: 'email', name: 'email' }));
  document.body.appendChild(el('input', { id: 'policy-gender', type: 'text', name: 'gender' }));
  document.body.appendChild(el('input', { id: 'policy-veteran', type: 'text', name: 'veteran' }));
  document.body.appendChild(el('input', { id: 'missing-portfolio', type: 'text', name: 'portfolio' }));
  document.body.appendChild(el('input', { id: 'required-notice', type: 'text', name: 'notice', required: true }));
}

function panelInstructions() {
  return [
    { field_id: 'ready-name', action: 'fill', value: 'Jane Doe', source: 'profile' },
    { field_id: 'ready-email', action: 'fill', value: 'jane@example.com', source: 'profile' },
    { field_id: 'policy-gender', action: 'skip', reason: 'Demographic question', source: 'policy' },
    { field_id: 'policy-veteran', action: 'skip', reason: 'Sensitive question', source: 'unsupported' },
    { field_id: 'missing-portfolio', action: 'skip', reason: 'No portfolio value', source: '' },
    { field_id: 'required-notice', action: 'skip', reason: 'Policy declined', source: 'policy' },
  ];
}

const PANEL_AUTOFILL = {
  instructions: panelInstructions(),
  ready_count: 2,
  review_count: 1,
  skipped_count: 3,
};

async function chipRetryCases(tree) {
  // The form is rendered ~4 s after injection, well past the old single 700 ms
  // attempt; the mutation must still produce the chip, exactly once.
  {
    const handle = bootTop(tree, { build() {}, autofill: { instructions: [] } });
    await sleep(900); // The first mount attempt has already run and found nothing.
    assert.equal(chipHosts(handle.document).length, 0, `${tree}: no chip before a form is rendered`);

    await sleep(3100); // ~4 s after the module loaded.
    addFormFields(handle.document);
    const observer = chipObserver(handle);
    assert.ok(observer, `${tree}: the chip watch is live after the first attempt`);
    observer.trigger();
    await waitFor(() => chipHosts(handle.document).length > 0, { timeout: 2000 });

    const hosts = chipHosts(handle.document);
    assert.equal(hosts.length, 1, `${tree}: the late-rendered form mounts one chip`);
    const button = hosts[0].shadowRoot && hosts[0].shadowRoot.querySelector('button');
    assert.ok(button, `${tree}: the chip exposes its prepare button`);
    assert.match(
      button.getAttribute('aria-label') || '',
      /AutoApply/,
      `${tree}: the chip button is the AutoApply prepare control`,
    );

    // A second mutation burst must not mount a second chip.
    observer.trigger();
    await sleep(400);
    assert.equal(chipHosts(handle.document).length, 1, `${tree}: the chip is never mounted twice`);
  }

  // Starting the flow ends the watch: no chip mounts while the panel is open,
  // even when a form becomes renderable afterwards.
  {
    const handle = bootTop(tree, { build() {}, autofill: { instructions: [] } });
    await sleep(900);
    const observer = chipObserver(handle);
    assert.ok(observer, `${tree}: the chip watch is live before the flow starts`);
    await handle.start();
    assert.equal(observer.disconnected, true, `${tree}: a flow start disconnects the chip watch`);

    addFormFields(handle.document);
    observer.trigger();
    await sleep(400);
    assert.equal(chipHosts(handle.document).length, 0, `${tree}: no chip mounts once the flow owns the page`);
  }

  // Dismissing the panel suppresses the chip on this URL for good.
  {
    const handle = bootTop(tree, {
      build: panelFields,
      autofill: PANEL_AUTOFILL,
    });
    const panel = await handle.start();
    panel.querySelector('.autoapply-close-btn').click();
    await sleep(450); // Past the 350 ms re-check removeOverlay() schedules.

    addFormFields(handle.document);
    const observer = chipObserver(handle);
    if (observer) observer.trigger();
    await sleep(400);
    assert.equal(chipHosts(handle.document).length, 0, `${tree}: a dismissed panel does not leave a chip behind`);
  }
}

async function panelGroupingCases(tree) {
  const handle = bootTop(tree, { build: panelFields, autofill: PANEL_AUTOFILL });
  const panel = await handle.start();

  const groups = panel.querySelectorAll('.autoapply-field-group');
  assert.equal(groups.length, 4, `${tree}: ready, review, skipped and collapsed groups render`);

  // Exactly one collapsed summary row, and its count matches the rows inside.
  const collapsed = panel.querySelectorAll('.autoapply-field-group-collapsed');
  assert.equal(collapsed.length, 1, `${tree}: policy/unsupported skips collapse into a single row`);
  const collapsedRows = collapsed[0].querySelectorAll('.autoapply-field-row');
  assert.equal(collapsedRows.length, 2, `${tree}: the collapsed row hides exactly the two policy skips`);
  const summaryCount = collapsed[0].querySelectorAll('b')[0].textContent.trim();
  assert.equal(summaryCount, '2', `${tree}: the collapsed summary count equals the collapsed rows`);

  const collapsedLabels = Array.from(
    collapsed[0].querySelectorAll('.autoapply-field-label'),
    (label) => label.textContent.trim().replace(/\s*\*$/, ''),
  ).sort();
  assert.deepEqual(
    collapsedLabels,
    ['gender', 'veteran'],
    `${tree}: only the non-required policy/unsupported skips are collapsed`,
  );

  // A required field we declined to fill is a blocker: it stays in the visible
  // review group instead of behind the collapsed summary.
  const review = panel.querySelector('.autoapply-field-group-review');
  assert.ok(review, `${tree}: the review group is rendered`);
  const reviewLabels = Array.from(
    review.querySelectorAll('.autoapply-field-label'),
    (label) => label.textContent.trim().replace(/\s*\*$/, ''),
  );
  assert.deepEqual(reviewLabels, ['notice'], `${tree}: the required-unfilled skip stays visible in review`);

  // A skip with no policy source is a gap, not a policy decision: its own
  // visible group, not the collapsed one.
  const skipped = panel.querySelector('.autoapply-field-group-skipped');
  assert.ok(skipped, `${tree}: the missing-value skip keeps its own group`);
  const skippedLabels = Array.from(
    skipped.querySelectorAll('.autoapply-field-label'),
    (label) => label.textContent.trim().replace(/\s*\*$/, ''),
  );
  assert.deepEqual(skippedLabels, ['portfolio'], `${tree}: the missing-value skip is not collapsed with policy rows`);
}

async function main() {
  for (const tree of TREES) {
    await chipRetryCases(tree);
    await panelGroupingCases(tree);
  }
  console.log('overlay chip and panel tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
