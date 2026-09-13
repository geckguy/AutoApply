#!/usr/bin/env node

/*
 * Behavioral tests for content/scraper.js — the field/label/option extraction
 * that decides what the backend may fill and which options it may choose from.
 *
 * The real content script (plus the shared findLabel it delegates to) runs in
 * the vm harness against a realistic job-form fragment, for both browser trees.
 */
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createContext, el, loadScripts, text } = require('./fake-dom');

const root = path.resolve(__dirname, '..', '..');
const TREES = ['extension', 'extension-chrome'];

/**
 * A job-application form with the shapes that break naive scrapers: a labelled
 * text input, a select, a CSS-hidden resume input behind a styled widget, two
 * radio groups (one labelled by legend, one answered), and a field whose only
 * label is an aria-labelledby reference.
 */
function buildForm(document) {
  const fullName = el('input', { id: 'full-name', name: 'fullName', type: 'text', placeholder: 'Jane Doe' });
  const workAuth = el(
    'select',
    { id: 'work-auth', name: 'workAuth', required: true },
    el('option', { value: '' }, 'Select…'),
    el('option', { value: 'yes' }, 'Yes, I am authorized'),
    el('option', { value: 'no' }, 'No'),
  );
  const resume = el('input', {
    id: 'resume-file',
    name: 'resume',
    type: 'file',
    accept: '.pdf,.docx',
    required: true,
    style: 'display:none',
  });
  const radioNo = el('input', { type: 'radio', name: 'sponsorship', value: '0', 'aria-label': 'No' });
  const radioYes = el('input', { type: 'radio', name: 'sponsorship', value: '1', 'aria-label': 'Yes', required: true });
  const sponsorshipYes = el('input', {
    type: 'radio',
    name: 'sponsorship-required',
    value: '1',
    'aria-label': 'Yes',
    checked: true,
  });
  const sponsorshipNo = el('input', { type: 'radio', name: 'sponsorship-required', value: '0', 'aria-label': 'No' });
  const phone = el('input', { id: 'phone-field', name: 'phone', type: 'tel', 'aria-labelledby': 'phone-label' });

  document.body.appendChild(el(
    'form',
    { id: 'apply-form' },
    el('div', { class: 'field' }, el('label', { for: 'full-name' }, 'Full name'), fullName),
    el('div', { class: 'field' }, el('label', { for: 'work-auth' }, 'Work authorization'), workAuth),
    el('div', { class: 'upload' }, el('label', { for: 'resume-file' }, 'Resume'), resume),
    el('fieldset', {}, el('legend', {}, 'Are you legally authorized to work? *'), radioNo, radioYes),
    el('fieldset', {}, el('legend', {}, 'Will you require sponsorship?'), sponsorshipYes, sponsorshipNo),
    el('div', { class: 'field' }, el('span', { id: 'phone-label' }, 'Mobile phone'), phone),
    el(
      'div',
      { class: 'job-description' },
      el('nav', {}, 'Skip to main content'),
      text('\n'),
      el('p', {}, 'We are hiring a backend engineer to build the AutoApply application pipeline.'),
      text('\n'),
      el('p', {}, 'You will own the form scraping and autofill flows end to end.'),
      text('\n'),
      el('button', {}, 'Apply now'),
      text('\n'),
    ),
  ));

  return { resume, radioNo, radioYes, sponsorshipYes, sponsorshipNo, phone };
}

function scrape(tree) {
  const { context, document } = createContext({ href: 'https://jobs.example.com/apply/42' });
  const nodes = buildForm(document);
  loadScripts(context, root, [
    `${tree}/lib/utils.js`,
    `${tree}/content/filler.js`,
    `${tree}/content/scraper.js`,
  ]);
  const scraper = context.window.__autoapply_scraper_module;
  assert.ok(scraper, `${tree}: content/scraper.js exposes its module`);
  return { ...scraper.scrapeFormFields(), nodes };
}

for (const tree of TREES) {
  const { fields, job_description: jobDescription, nodes } = scrape(tree);

  // Only a scraper that resolved every question once is safe to fill.
  assert.equal(
    new Set(fields.map((field) => field.id)).size,
    fields.length,
    `${tree}: every scraped field has a distinct id`,
  );

  {
    const field = fields.find((candidate) => candidate.name === 'fullName');
    assert.deepEqual(
      {
        id: field.id,
        type: field.type,
        label: field.label,
        placeholder: field.placeholder,
        required: field.required,
        options: Array.from(field.options),
      },
      {
        id: 'full-name',
        type: 'text',
        label: 'Full name',
        placeholder: 'Jane Doe',
        required: false,
        options: [],
      },
      `${tree}: a labelled text input keeps its id, label, placeholder and required flag`,
    );
  }

  {
    const field = fields.find((candidate) => candidate.name === 'workAuth');
    assert.equal(field.type, 'select', `${tree}: a <select> is typed as a select`);
    assert.equal(field.label, 'Work authorization', `${tree}: the select label comes from its <label for>`);
    assert.equal(field.required, true, `${tree}: the select keeps its required flag`);
    assert.deepEqual(
      Array.from(field.options),
      ['Yes, I am authorized', 'No'],
      `${tree}: select options are the option text, skipping the empty placeholder`,
    );
  }

  {
    // The dominant styled-upload pattern: the native input is the only thing a
    // resume can be attached to, so dropping it loses the whole upload row.
    assert.equal(nodes.resume.style.display, 'none', `${tree}: fixture models a CSS-hidden file input`);
    const field = fields.find((candidate) => candidate.type === 'file');
    assert.ok(field, `${tree}: a CSS-hidden file input still reaches the scraped schema`);
    assert.equal(field.id, 'resume-file', `${tree}: the file input keeps its id`);
    assert.equal(field.label, 'Resume', `${tree}: the file input keeps its label`);
    assert.equal(field.required, true, `${tree}: the file input keeps its required flag`);
    assert.equal(field.accept, '.pdf,.docx', `${tree}: the file input keeps its accept filter`);
  }

  {
    const group = fields.find((candidate) => candidate.name === 'sponsorship');
    assert.equal(
      fields.filter((candidate) => candidate.name === 'sponsorship').length,
      1,
      `${tree}: one field per named radio group, not one per member`,
    );
    assert.equal(group.type, 'radio', `${tree}: the group is typed as a radio question`);
    assert.equal(
      group.label,
      'Are you legally authorized to work?',
      `${tree}: the group label comes from its <legend>, with the required marker stripped`,
    );
    assert.deepEqual(
      Array.from(group.options),
      ['No', 'Yes'],
      `${tree}: group options are each member's own label, in document order`,
    );
    assert.equal(group.required, true, `${tree}: the group is required when a member is required`);
    assert.equal(group.value, '', `${tree}: an unanswered group has an empty value`);
    assert.equal(
      group.group_name,
      'sponsorship',
      `${tree}: the group records the shared input name`,
    );
    for (const member of [nodes.radioNo, nodes.radioYes]) {
      assert.equal(
        member.getAttribute('data-autoapply-id'),
        group.id,
        `${tree}: every member shares the group id so the filler can resolve it`,
      );
    }
  }

  {
    const group = fields.find((candidate) => candidate.name === 'sponsorship-required');
    assert.equal(
      group.value,
      'Yes',
      `${tree}: an already-answered group reports the checked member's label as its value`,
    );
    assert.deepEqual(Array.from(group.options), ['Yes', 'No'], `${tree}: the answered group keeps its option list`);
  }

  {
    const field = fields.find((candidate) => candidate.name === 'phone');
    assert.equal(field.id, 'phone-field', `${tree}: the field keeps its id`);
    assert.equal(field.type, 'tel', `${tree}: the field keeps its input type`);
    assert.equal(field.label, 'Mobile phone', `${tree}: a field labelled only via aria-labelledby is named`);
  }

  assert.match(jobDescription, /backend engineer/, `${tree}: the job description is extracted`);
  assert.match(jobDescription, /form scraping/, `${tree}: multi-paragraph descriptions are preserved`);
  assert.doesNotMatch(
    jobDescription,
    /Skip to main content|Apply now/,
    `${tree}: navigation and buttons are stripped from the description`,
  );
}

console.log('scraper field-extraction tests passed');
