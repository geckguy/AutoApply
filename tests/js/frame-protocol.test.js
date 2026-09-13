#!/usr/bin/env node

/*
 * Behavior of the overlay's embedded-frame protocol.
 *
 * A child frame only answers questions about itself; the top frame merges the
 * fields a frame reports and routes each frame's instructions back to it. These
 * cases drive the real extension/content/overlay.js through its message
 * listener and the AA_* postMessage surface — never through its internals.
 */
'use strict';

const assert = require('node:assert/strict');
const { bootTop, bootChild, waitFor, sleep } = require('./overlay-harness');
const { el } = require('./fake-dom');

const TREES = ['extension', 'extension-chrome'];

function childForm(document) {
  document.body.appendChild(el('input', { id: 'child_email', type: 'email', name: 'email' }));
  document.body.appendChild(el('input', { id: 'child_phone', type: 'tel', name: 'phone' }));
}

function messageRequest(overrides = {}) {
  return {
    __autoapply: true,
    token: 'tok-1',
    type: 'AA_SCRAPE',
    frameTag: 'f1',
    ...overrides,
  };
}

async function childFrameCases(tree) {
  // (a) A child frame answers messages but mounts nothing of its own.
  {
    const child = bootChild(tree, { build: childForm });
    assert.equal(
      child.document.getElementById('autoapply-ready-chip-host'),
      null,
      `${tree}: a child frame mounts no ready chip`,
    );
    assert.equal(
      child.document.getElementById('autoapply-shadow-host'),
      null,
      `${tree}: a child frame mounts no panel`,
    );
    assert.equal(
      child.window.__autoapply_scraper,
      undefined,
      `${tree}: a child frame does not scan the page on load`,
    );
  }

  // (b) AA_SCRAPE from window.parent yields a result carrying the real fields.
  {
    const child = bootChild(tree, { build: childForm });
    child.window.dispatchEvent({ type: 'message', data: messageRequest(), source: child.parentWindow });
    const reply = await waitFor(() => child.posts.find((post) => post.type === 'AA_SCRAPE_RESULT'));
    assert.equal(reply.ok, true, `${tree}: the scrape reply is ok`);
    assert.equal(reply.token, 'tok-1', `${tree}: the reply echoes the request token`);
    assert.equal(reply.frameTag, 'f1', `${tree}: the reply echoes the frame tag`);
    const ids = Array.from(reply.fields, (field) => field.id).sort();
    assert.deepEqual(ids.sort(), ['child_email', 'child_phone'], `${tree}: the reply carries this frame's scraped fields`);
  }

  // (c) A message from the wrong source, without the envelope, or with a
  // different token after a token is locked, is ignored.
  {
    const child = bootChild(tree, { build: childForm });
    child.window.dispatchEvent({ type: 'message', data: messageRequest({ type: 'AA_PROBE' }), source: child.parentWindow });
    await waitFor(() => child.posts.find((post) => post.type === 'AA_PROBE_RESULT'));
    const baseline = child.posts.length;

    const stranger = { postMessage() {} };
    child.window.dispatchEvent({ type: 'message', data: messageRequest({ type: 'AA_PROBE' }), source: stranger });
    child.window.dispatchEvent({ type: 'message', data: { token: 'tok-1', type: 'AA_PROBE' }, source: child.parentWindow });
    child.window.dispatchEvent({ type: 'message', data: messageRequest({ type: 'AA_PROBE', token: 'tok-2' }), source: child.parentWindow });
    await sleep(30);
    assert.equal(child.posts.length, baseline, `${tree}: a stranger, a missing envelope, or a wrong token is ignored`);
  }
}

async function topFrameCase(tree) {
  const handle = bootTop(tree, {
    build(document) {
      document.body.appendChild(el('input', { id: 'local_name', type: 'text', name: 'name' }));
      document.body.appendChild(el('input', { id: 'local_email', type: 'email', name: 'email' }));
    },
    frames: [{ tag: 'f1', fields: [{ id: 'child_phone', type: 'tel', label: 'Phone', required: false }] }],
    autofill: {
      instructions: [
        { field_id: 'local_name', action: 'fill', value: 'Jane Doe' },
        { field_id: 'f1:child_phone', action: 'fill', value: '+1 555 0100' },
        { field_id: 'f9:ghost', action: 'fill', value: 'ghost' },
      ],
      ready_count: 3,
      review_count: 0,
      skipped_count: 0,
    },
  });
  const panel = await handle.start();

  // The child's field is merged under its frame prefix and marked as living on
  // the page (no inline editor in this document).
  assert.equal(
    panel.querySelectorAll('.autoapply-edit-note').length,
    1,
    `${tree}: the merged child field renders as a frame-owned row`,
  );

  panel.querySelector('.autoapply-fill-only-btn').click();
  await waitFor(() => handle.sent.some((entry) => entry.message.type === 'AA_FILL'));

  const scrapes = handle.sent.filter((entry) => entry.message.type === 'AA_SCRAPE');
  assert.equal(scrapes.length >= 1, true, `${tree}: the top frame asks each child frame for its fields`);

  const fills = handle.sent.filter((entry) => entry.message.type === 'AA_FILL');
  assert.equal(fills.length, 1, `${tree}: exactly the frame with a routed instruction is asked to fill`);
  assert.equal(fills[0].tag, 'f1', `${tree}: the fill goes to the frame that owns the field`);
  assert.deepEqual(
    Array.from(fills[0].message.instructions, (instruction) => instruction.field_id),
    ['child_phone'],
    `${tree}: only the owning frame's local id is routed, with the prefix stripped`,
  );
  const routed = JSON.stringify(handle.sent.map((entry) => entry.message));
  assert.equal(routed.includes('local_name'), false, `${tree}: a local id is never handed to an embedded frame`);
  assert.equal(routed.includes('f9:ghost'), false, `${tree}: an id for a frame that reported nothing is never routed`);
}

async function main() {
  for (const tree of TREES) {
    await childFrameCases(tree);
    await topFrameCase(tree);
  }
  console.log('frame protocol tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
