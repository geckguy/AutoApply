#!/usr/bin/env node

/*
 * Table-driven checks for lib/utils.js company/role extraction. Each fixture is
 * a real job-board URL (with the structured data or heading the board actually
 * renders) and asserts the employer and role the panel must show.
 *
 * The employer priority is JSON-LD -> og:site_name -> the site adapter table ->
 * the title tail -> 'Unknown'; a generic host word ('jobs', 'job-boards',
 * 'boards', 'careers') must never be returned as a company for any fixture.
 *
 * Set AA_UTILS_FILE to point the suite at a different utils.js copy (used to
 * show the assertions fail against the pre-change file).
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createContext, el, text } = require('./fake-dom');

const root = path.resolve(__dirname, '..', '..');
const TREES = ['extension', 'extension-chrome'];
const OVERRIDE_FILE = process.env.AA_UTILS_FILE || '';

const GENERIC_HOST_WORDS = ['jobs', 'job-boards', 'boards', 'careers'];

function utilsSource(tree) {
  return OVERRIDE_FILE
    ? fs.readFileSync(OVERRIDE_FILE, 'utf8')
    : fs.readFileSync(path.join(root, tree, 'lib', 'utils.js'), 'utf8');
}

function h1(document, value) {
  document.body.appendChild(el('h1', {}, value));
}

function ldJson(document, value) {
  document.head.appendChild(el('script', { type: 'application/ld+json' }, text(JSON.stringify(value))));
}

function meta(document, property, content) {
  document.head.appendChild(el('meta', { property, content }));
}

// A JobPosting block as the boards that embed JSON-LD emit it.
function jobPosting({ company, title }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title,
    hiringOrganization: { '@type': 'Organization', name: company },
  };
}

const FIXTURES = [
  {
    name: 'Greenhouse job-boards path slug',
    url: 'https://job-boards.greenhouse.io/truveta/jobs/6105750004',
    title: 'Senior Software Engineer - Truveta',
    build: (document) => h1(document, 'Senior Software Engineer'),
    company: 'Truveta',
    role: 'Senior Software Engineer',
  },
  {
    name: 'Greenhouse boards.io with JSON-LD',
    url: 'https://boards.greenhouse.io/andurilindustries/jobs/4830125007',
    title: 'Software Engineer, Mission Systems',
    build: (document) => {
      ldJson(document, jobPosting({ company: 'Anduril Industries', title: 'Software Engineer, Mission Systems' }));
      h1(document, 'A heading the JSON-LD must override');
    },
    company: 'Anduril Industries',
    role: 'Software Engineer, Mission Systems',
  },
  {
    name: 'Greenhouse embed honours the for= parameter',
    url: 'https://job-boards.greenhouse.io/embed/job_app?for=stripe&token=1',
    title: 'Backend Engineer - Stripe',
    build: (document) => h1(document, 'Backend Engineer'),
    company: 'Stripe',
    role: 'Backend Engineer',
  },
  {
    name: 'Lever never reports the board name as company or role',
    url: 'https://jobs.lever.co/leverdemo/58db3f8e-b108-47d1-9e6e-87a1712497cd/apply',
    title: 'Lever Demo 2',
    build: (document) => h1(document, 'Senior Backend Engineer'),
    company: 'Leverdemo',
    role: 'Senior Backend Engineer',
  },
  {
    name: 'Ashby path slug',
    url: 'https://jobs.ashbyhq.com/pinecone/773e953d-8f53-4313-93b4-35a553bad1cb/application',
    title: 'Machine Learning Engineer - Pinecone',
    build: (document) => h1(document, 'Machine Learning Engineer'),
    company: 'Pinecone',
    role: 'Machine Learning Engineer',
  },
  {
    name: 'SmartRecruiters camel-case slug is humanised',
    url: 'https://jobs.smartrecruiters.com/RaisingCanes/744000149198209-restaurant-manager',
    title: 'Jobs at Raising Cane\'s',
    build: (document) => h1(document, 'Restaurant Manager'),
    company: 'Raising Canes',
    role: 'Restaurant Manager',
  },
  {
    name: 'Workday tenant subdomain',
    url: 'https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/1234/Software-Engineer',
    title: 'Software Engineer - NVIDIA',
    build: (document) => h1(document, 'Software Engineer'),
    company: 'Nvidia',
    role: 'Software Engineer',
  },
  {
    name: 'iCIMS careers subdomain',
    url: 'https://careers-gdit.icims.com/jobs/search',
    title: 'Careers at GDIT',
    build: (document) => h1(document, 'Systems Engineer'),
    company: 'Gdit',
    role: 'Systems Engineer',
  },
  {
    name: 'non-ATS careers page via title tail',
    url: 'https://www.acme.com/careers/open-positions',
    title: 'Careers at Acme',
    build: (document) => h1(document, 'Staff Engineer'),
    company: 'Acme',
    role: 'Staff Engineer',
  },
  {
    name: 'non-ATS multi-word employer from the title',
    url: 'https://careers.northwind.example/jobs/12345',
    title: 'Backend Engineer - Northwind Traders',
    build: (document) => h1(document, 'Backend Engineer'),
    company: 'Northwind Traders',
    role: 'Backend Engineer',
  },
  {
    name: 'bare generic title yields Unknown, not a host word',
    url: 'https://www.example.com/careers',
    title: 'Careers',
    build: () => {},
    company: 'Unknown',
    role: 'Unknown',
  },
];

const PLATFORMS = [
  ['https://job-boards.greenhouse.io/truveta/jobs/1', 'greenhouse'],
  ['https://jobs.lever.co/acme/1/apply', 'lever'],
  ['https://jobs.ashbyhq.com/acme/1', 'ashby'],
  ['https://nvidia.wd5.myworkdayjobs.com/en-US/x/job/1', 'workday'],
  ['https://careers-gdit.icims.com/jobs/search', 'icims'],
  ['https://www.acme.com/careers/open-positions', 'custom'],
];

const failures = [];

function check(label, run) {
  try {
    run();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

function runFixture(tree, source, fixture) {
  const { context, document } = createContext({ href: fixture.url });
  fixture.build(document);
  vm.runInContext(source, context, { filename: 'utils.js' });
  const utils = context.window.__autoapply_utils;
  assert.ok(utils, `${tree}: lib/utils.js exposes window.__autoapply_utils`);

  const label = `${tree} [${fixture.name}]`;
  let company;
  let role;
  check(`${label} company`, () => {
    assert.equal(typeof utils.extractCompany, 'function', 'extractCompany must be exported');
    company = utils.extractCompany(fixture.url, fixture.title);
    assert.equal(company, fixture.company);
  });
  check(`${label} role`, () => {
    assert.equal(typeof utils.extractRole, 'function', 'extractRole must be exported');
    role = utils.extractRole(fixture.url, fixture.title, document);
    assert.equal(role, fixture.role);
  });
  check(`${label} company is never a generic host word`, () => {
    const value = company ?? utils.extractCompany(fixture.url, fixture.title);
    for (const word of GENERIC_HOST_WORDS) {
      assert.notEqual(String(value).toLowerCase(), word);
    }
  });
}

function runPlatformChecks(tree, source) {
  const { context } = createContext();
  vm.runInContext(source, context, { filename: 'utils.js' });
  const utils = context.window.__autoapply_utils;
  for (const [url, expected] of PLATFORMS) {
    check(`${tree} detectPlatform(${url})`, () => {
      assert.equal(utils.detectPlatform(url), expected);
    });
  }
  check(`${tree} humanizeSlug splits camel case`, () => {
    assert.equal(utils.humanizeSlug('RaisingCanes'), 'Raising Canes');
  });
  check(`${tree} humanizeSlug keeps short acronyms`, () => {
    assert.equal(utils.humanizeSlug('GDIT'), 'GDIT');
  });
}

for (const tree of TREES) {
  const source = utilsSource(tree);
  for (const fixture of FIXTURES) runFixture(tree, source, fixture);
  runPlatformChecks(tree, source);
}

if (failures.length) {
  for (const failure of failures) console.error(`site adapter FAIL: ${failure}`);
  console.error(`site adapter tests: ${failures.length} failure(s)`);
  process.exit(1);
}

console.log('site adapter tests passed');
