#!/usr/bin/env node

/*
 * Behavioral tests for content/filler.js beyond the navigation guard in
 * filler-safety.test.js: the fixed behaviors a plausible regression would
 * break — submit-like detection for typeless buttons, the fixed-position CTA,
 * value verification on typed inputs, date normalisation, and radio groups.
 *
 * Each case loads the real content script for both browser trees into the vm
 * harness in fake-dom.js.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createContext, el, loadScripts } = require('./fake-dom');

const root = path.resolve(__dirname, '..', '..');
const TREES = ['extension', 'extension-chrome'];

function loadFiller(tree) {
  const { context, document } = createContext();
  loadScripts(context, root, [`${tree}/lib/utils.js`, `${tree}/content/filler.js`]);
  const filler = context.window.__autoapply_filler;
  assert.ok(filler, `${tree}: content/filler.js exposes its module`);
  return { filler, document };
}

async function main() {
  for (const tree of TREES) {
    // A typeless <button> defaults to type="submit" in the DOM, but it can only
    // submit when it has an owner form. An unrelated one (cookie banner, menu)
    // must not mark every page of a multi-step form as the final one.
    {
      const { filler, document } = loadFiller(tree);
      const cookieBanner = el('button', {}, 'Accept cookies');
      const next = el('button', { type: 'button' }, 'Continue');
      document.body.append(cookieBanner, next);

      assert.equal(cookieBanner.type, 'submit', `${tree}: fixture models the browser default for a typeless <button>`);
      assert.equal(cookieBanner.form, null, `${tree}: fixture places the typeless button outside any form`);

      const state = filler.isLastPage();
      assert.equal(state.isLast, false, `${tree}: a typeless button outside a form does not make the page final`);
      assert.equal(state.isAmbiguous, false, `${tree}: a safe Continue keeps the page unambiguous`);
      assert.equal(filler.clickNextButton(), true, `${tree}: the Continue control still advances`);
      assert.equal(next.clickCount, 1, `${tree}: the Continue control was clicked`);
      assert.equal(cookieBanner.clickCount, 0, `${tree}: the unrelated button was never clicked`);
    }

    // A real submit control inside the form is still a hard safety boundary.
    {
      const { filler, document } = loadFiller(tree);
      const submit = el('button', { type: 'submit' }, 'Submit application');
      const next = el('button', { type: 'button' }, 'Continue');
      document.body.appendChild(el('form', {}, submit, next));

      assert.equal(submit.form !== null, true, `${tree}: fixture puts the submit button inside a form`);
      const state = filler.isLastPage();
      assert.equal(state.isLast, true, `${tree}: a real type=submit inside the form marks the page final`);
      assert.match(state.reason, /submit-like control/, `${tree}: the reason names the submit control`);
      assert.equal(filler.clickNextButton(), false, `${tree}: navigation never advances past a submit control`);
      assert.equal(submit.clickCount, 0, `${tree}: the submit control was not clicked`);
      assert.equal(next.clickCount, 0, `${tree}: not even the safe control is clicked on a final page`);
    }

    // A fixed-position Continue CTA has offsetParent === null but is rendered;
    // judging visibility by offsetParent hides it and blocks the main CTA.
    {
      const { filler, document } = loadFiller(tree);
      const cta = el('button', { type: 'button', style: 'position:fixed', class: 'primary' }, 'Continue');
      document.body.appendChild(cta);

      assert.equal(cta.offsetParent, null, `${tree}: fixture models a fixed-position control's null offsetParent`);
      assert.equal(filler.isLastPage().isLast, false, `${tree}: a fixed Continue is recognised as a safe next control`);
      assert.equal(filler.clickNextButton(), true, `${tree}: the fixed Continue can be clicked`);
      assert.equal(cta.clickCount, 1, `${tree}: the fixed Continue was clicked`);
    }

    // Typed inputs run the browser's value-sanitisation: "5+ years" never lands
    // in a number input, so reporting success would hide the empty field.
    {
      const { filler, document } = loadFiller(tree);
      const years = el('input', { id: 'years', type: 'number' });
      document.body.appendChild(years);

      const outcome = await filler.fillField({ field_id: 'years', action: 'fill', value: '5+ years' });
      assert.equal(outcome.ok, false, `${tree}: a value the number input rejects is reported as a failure`);
      assert.equal(years.value, '', `${tree}: the rejected value never lands in the DOM`);
    }

    // The backend emits MM/DD/YYYY; a native date input only accepts
    // YYYY-MM-DD, so the value has to be normalised to land at all.
    {
      const { filler, document } = loadFiller(tree);
      const start = el('input', { id: 'start-date', type: 'date' });
      document.body.appendChild(start);

      const outcome = await filler.fillField({ field_id: 'start-date', action: 'fill', value: '01/15/2024' });
      assert.equal(outcome.ok, true, `${tree}: a normalisable date is reported as filled`);
      assert.equal(start.value, '2024-01-15', `${tree}: MM/DD/YYYY lands as the date input's YYYY-MM-DD`);
    }

    // Options are matched by label AND by the input's own value. Guessing on a
    // miss inverts answers on legal questions.
    {
      const { filler, document } = loadFiller(tree);
      const no = el('input', { type: 'radio', name: 'sponsorship', value: '0', 'aria-label': 'No', 'data-autoapply-id': 'group-1' });
      const yes = el('input', { type: 'radio', name: 'sponsorship', value: '1', 'aria-label': 'Yes', 'data-autoapply-id': 'group-1' });
      document.body.append(no, yes);

      const answered = await filler.fillField({ field_id: 'group-1', action: 'check', value: 'Yes' });
      assert.equal(answered.ok, true, `${tree}: the requested option is reported as filled`);
      assert.equal(yes.checked, true, `${tree}: the Yes member is the one that gets checked`);
      assert.equal(no.checked, false, `${tree}: the No member is not checked when Yes was requested`);

      const absent = await filler.fillField({ field_id: 'group-1', action: 'check', value: 'Maybe' });
      assert.equal(absent.ok, false, `${tree}: an option the group does not offer fails instead of guessing`);
      assert.equal(yes.checked, true, `${tree}: the failed attempt leaves the group unchanged`);
      assert.equal(no.checked, false, `${tree}: the failed attempt checks no other member`);
    }

    // A member's own value is a valid match too (values are 1/0, not labels).
    {
      const { filler, document } = loadFiller(tree);
      const no = el('input', { type: 'radio', name: 'authorized', value: '0', 'aria-label': 'No', 'data-autoapply-id': 'group-2' });
      const yes = el('input', { type: 'radio', name: 'authorized', value: '1', 'aria-label': 'Yes', 'data-autoapply-id': 'group-2' });
      document.body.append(no, yes);

      const answered = await filler.fillField({ field_id: 'group-2', action: 'check', value: '1' });
      assert.equal(answered.ok, true, `${tree}: a member is selectable by its value attribute`);
      assert.equal(yes.checked, true, `${tree}: the member whose value was requested is checked`);
      assert.equal(no.checked, false, `${tree}: no other member is checked`);
    }

    // A phone mask that keeps every digit but rewrites the separators is a
    // success, not a silent byte-level failure: the panel must be told the
    // value landed reformatted and what it actually became.
    {
      const { filler, document } = loadFiller(tree);
      const phone = el('input', { id: 'phone-reformat', type: 'tel' });
      phone.addEventListener('input', () => {
        const digits = phone.value.replace(/\D/g, '');
        if (digits.length === 8) phone.value = `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 8)}`;
      });
      document.body.appendChild(phone);

      const result = await filler.fillAllFields([
        { field_id: 'phone-reformat', action: 'fill', value: '+1 555 0100' },
      ]);
      assert.equal(result.filled, 1, `${tree}: a formatting-only rewrite is reported as filled`);
      assert.equal(result.failed, 0, `${tree}: a formatting-only rewrite is not a failure`);
      assert.equal(result.reformatted.length, 1, `${tree}: the reformatted write is reported to the panel`);
      assert.equal(result.reformatted[0].field_id, 'phone-reformat', `${tree}: the reformatted entry names the field`);
      assert.equal(result.reformatted[0].value, '+1 555-010-0', `${tree}: the reformatted entry carries the landed value`);
      assert.equal(phone.value, '+1 555-010-0', `${tree}: the mask's own formatting is what stays in the DOM`);
    }

    // A mask that drops characters truncated our answer: that is a failure with
    // a reason the user can act on, and it must reach the failures list.
    {
      const { filler, document } = loadFiller(tree);
      const phone = el('input', { id: 'phone-truncated', type: 'tel' });
      phone.addEventListener('input', () => { phone.value = String(phone.value).slice(0, 6); });
      document.body.appendChild(phone);

      const result = await filler.fillAllFields([
        { field_id: 'phone-truncated', action: 'fill', value: '+1 555 0100' },
      ]);
      assert.equal(result.failed, 1, `${tree}: a truncated value is reported as a failure`);
      assert.equal(result.failures[0].field_id, 'phone-truncated', `${tree}: the failure names the truncated field`);
      assert.equal(result.failures[0].reason, 'The site truncated this value.', `${tree}: the failure explains the truncation`);
      // The digits-only retry is truncated too, so no attempt is quietly left
      // looking filled.
      assert.equal(phone.value, '155501', `${tree}: the truncated value is what remains in the DOM`);
    }

    // A mask that refuses separators accepts the digits-only retry: retrying
    // once with digits is the difference between an empty field and a filled one.
    {
      const { filler, document } = loadFiller(tree);
      const phone = el('input', { id: 'phone-digits', type: 'tel' });
      phone.addEventListener('input', () => {
        phone.value = /^\d+$/.test(phone.value) ? phone.value : '';
      });
      document.body.appendChild(phone);

      const outcome = await filler.fillField({ field_id: 'phone-digits', action: 'fill', value: '+1 555 0100' });
      assert.equal(outcome.ok, true, `${tree}: the digits-only retry is reported as filled`);
      assert.equal(outcome.reformatted, true, `${tree}: the retried value is flagged as reformatted`);
      assert.equal(outcome.landed_value, '15550100', `${tree}: the digits the mask accepted are reported`);
      assert.equal(phone.value, '15550100', `${tree}: the accepted digits are what stays in the DOM`);
    }
  }

  console.log('filler behavior tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
