const API_BASE = '';
const THEME_KEY = 'autoapply-theme';
const state = {
    opportunities: [], overview: {}, profile: null, knowledge: '', filtered: [],
    activeView: 'today', applicationLayout: 'list', selectedId: null,
    lastFocus: null, addJobFocus: null, duplicatePayload: null,
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
const safeUrl = (value) => /^https?:\/\//i.test(value || '') ? value : '';
const closedStatuses = new Set(['accepted', 'rejected', 'withdrawn', 'archived']);

function resolvedTheme(preference) {
    return preference === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : preference;
}

function applyTheme(preference = 'system', persist = true) {
    const safePreference = ['system', 'light', 'dark'].includes(preference) ? preference : 'system';
    document.documentElement.dataset.theme = resolvedTheme(safePreference);
    document.documentElement.dataset.themePreference = safePreference;
    $('#theme-select').value = safePreference;
    if (persist) localStorage.setItem(THEME_KEY, safePreference);
}

function statusLabel(status) {
    return ({ draft:'Draft', saved:'Saved', preparing:'Preparing', ready_to_review:'Ready to review', submitted:'Submitted', applied:'Applied', no_response:'No response', interview:'Interview', negotiating:'Negotiating', offer:'Offer', accepted:'Accepted', rejected:'Rejected', withdrawn:'Withdrawn', archived:'Archived' })[status] || 'In progress';
}

function formatDate(value, withTime = false) {
    if (!value) return 'Not scheduled';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not scheduled';
    return date.toLocaleDateString(undefined, withTime
        ? { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }
        : { month:'short', day:'numeric', year:'numeric' });
}

function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { element.className = 'toast'; }, 3600);
}

async function request(path, options = {}) {
    const headers = options.body instanceof FormData ? {} : { 'Content-Type':'application/json' };
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers:{ ...headers, ...(options.headers || {}) } });
    if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.detail || `Request failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
}

async function optionalRequest(path) {
    const response = await fetch(`${API_BASE}${path}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json();
}

function legacyOpportunity(item) {
    return {
        id: item.id, company: item.company, role: item.role, url: item.url,
        platform: item.platform, status: item.status, fit_score: item.fit_score,
        notes: item.notes, updated_at: item.applied_at, created_at: item.applied_at,
    };
}

function legacyOverview(items) {
    const countIn = (statuses) => items.filter((item) => statuses.has(item.status)).length;
    return {
        summary: {
            ready: countIn(new Set(['saved','preparing','ready_to_review'])),
            applied: countIn(new Set(['applied','submitted'])),
            interviews: countIn(new Set(['interview','negotiating'])),
            offers: countIn(new Set(['offer','accepted'])),
        },
        actions: [], reminders: [], upcoming_interviews: [],
        recent_activity: items.slice(0, 5),
        resumes: [], policies: [], answers: [],
    };
}

async function loadData() {
    $('#workspace-connection').textContent = 'Syncing local workspace…';
    $('#workspace-connection').className = 'connection-state';

    const [profile, knowledge] = await Promise.all([
        optionalRequest('/api/profile/').catch(() => null),
        optionalRequest('/api/profile/knowledge').catch(() => null),
    ]);
    state.profile = profile;
    state.knowledge = knowledge?.content || '';

    let workspaceError = null;
    let usedHistoryFallback = false;
    try {
        const [opportunities, overview] = await Promise.all([
            request('/api/workspace/opportunities?limit=500'),
            request('/api/workspace/overview'),
        ]);
        state.opportunities = opportunities.opportunities || [];
        state.overview = overview || {};
    } catch (error) {
        // WORKSPACE_API.md: the original application-history API stays available
        // as an always-on fallback, so a missing/broken workspace endpoint
        // degrades to history instead of blanking every panel.
        workspaceError = error;
        const history = await request('/api/applications/?limit=500').catch(() => null);
        if (history) {
            usedHistoryFallback = true;
            state.opportunities = history.map(legacyOpportunity);
            state.overview = legacyOverview(state.opportunities);
        } else {
            state.opportunities = [];
            state.overview = {};
        }
    }

    renderAll();
    if (usedHistoryFallback) {
        $('#workspace-connection').textContent = 'History fallback';
        $('#workspace-connection').className = 'connection-state ready';
        toast('The workspace API is unavailable; showing your saved application history.', true);
    } else if (workspaceError) {
        $('#workspace-connection').textContent = 'Backend unavailable';
        $('#workspace-connection').className = 'connection-state';
        toast(`${workspaceError.message}. Start the local backend on port 8000.`, true);
    } else {
        $('#workspace-connection').textContent = 'Workspace ready';
        $('#workspace-connection').className = 'connection-state ready';
    }

    const requestedId = new URLSearchParams(location.search).get('application');
    if (requestedId && state.opportunities.some((item) => item.id === requestedId)) {
        history.replaceState(null, '', `${location.pathname}#applications`);
        setActiveView('applications');
        await openDetail(requestedId);
    }
}

function renderAll() {
    renderToday();
    renderApplications();
    renderProfile();
    $('#nav-action-count').textContent = (state.overview.actions || []).length;
    $('#nav-app-count').textContent = state.opportunities.length;
}

function actionRow(action, index = 0) {
    const typeClass = action.overdue ? 'overdue' : action.type === 'interview' ? 'interview' : action.status === 'offer' ? 'offer' : '';
    return `<button class="action-row ${typeClass}" type="button" data-open-opportunity="${escapeHtml(action.opportunity_id || '')}">
        <span class="action-row-dot" aria-hidden="true"></span>
        <span><strong>${escapeHtml(action.title || 'Application')}</strong><small>${escapeHtml(action.reason || 'Review next')}${action.due_at ? ` · ${formatDate(action.due_at, true)}` : ''}</small></span>
        <span class="action-row-cta">${escapeHtml(index === 0 ? action.cta || 'Open' : 'Open')} →</span>
    </button>`;
}

function renderToday() {
    const summary = state.overview.summary || {};
    const actions = state.overview.actions || [];
    $('#metric-ready').textContent = summary.ready ?? 0;
    $('#metric-applied').textContent = summary.applied ?? 0;
    $('#metric-interviews').textContent = summary.interviews ?? 0;
    $('#metric-offers').textContent = summary.offers ?? 0;
    $('#action-count').textContent = actions.length;
    $('#today-summary').textContent = actions.length
        ? `${actions.length} item${actions.length === 1 ? '' : 's'} can move forward today. Start with the first one.`
        : 'Nothing is waiting on you. Capture a role or review the applications already in motion.';

    const first = actions[0];
    $('#next-action').className = `next-action${first ? '' : ' clear'}`;
    $('#next-action').innerHTML = first ? `
        <div class="next-action-copy"><p class="utility-label">First up</p><h2>${escapeHtml(first.title)}</h2><p>${escapeHtml(first.reason)}${first.due_at ? ` · ${formatDate(first.due_at, true)}` : ''}</p></div>
        <button class="button primary" type="button" data-open-opportunity="${escapeHtml(first.opportunity_id || '')}">${escapeHtml(first.cta || 'Open')} →</button>` : `
        <div class="next-action-copy"><p class="utility-label">Queue clear</p><h2>You are caught up.</h2><p>Add a role when you find one, or check the applications already in motion.</p></div>
        <button class="button primary" type="button" data-open-add-job>Add a role</button>`;
    $('#action-list').innerHTML = actions.length ? actions.slice(0, 8).map(actionRow).join('') : '<div class="empty-state">No reviews, follow-ups, interviews, or offers need attention.</div>';

    const schedule = [
        ...(state.overview.upcoming_interviews || []).map((item) => ({ ...item, scheduleType:'Interview', when:item.scheduled_at })),
        ...(state.overview.reminders || []).map((item) => ({ ...item, scheduleType:'Follow-up', when:item.due_at })),
    ].sort((a, b) => String(a.when || '').localeCompare(String(b.when || ''))).slice(0, 6);
    $('#schedule-list').innerHTML = schedule.length ? schedule.map((item) => `<div class="timeline-item"><strong>${escapeHtml(item.scheduleType)} · ${escapeHtml(item.company || 'Company')}</strong><small>${escapeHtml(item.role || item.notes || '')} · ${formatDate(item.when, true)}</small></div>`).join('') : '<div class="empty-state">Nothing scheduled. Add a follow-up from an application.</div>';

    const recent = state.overview.recent_activity || [];
    $('#recent-list').innerHTML = recent.length ? recent.slice(0, 5).map((item) => `<button class="compact-item" type="button" data-open-opportunity="${escapeHtml(item.id)}"><strong>${escapeHtml(item.company)} · ${escapeHtml(item.role)}</strong><small>${escapeHtml(statusLabel(item.status))} · ${formatDate(item.updated_at)}</small></button>`).join('') : '<div class="empty-state">No application activity yet.</div>';
}

function fitClass(score) { return typeof score !== 'number' ? '' : score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low'; }

function applicationRow(item) {
    return `<button class="application-row" type="button" data-open-opportunity="${escapeHtml(item.id)}">
        <span class="application-title"><strong>${escapeHtml(item.company || 'Unknown company')}</strong><small>${escapeHtml(item.role || 'Unknown role')}</small></span>
        <span class="application-platform"><span class="status-pill ${escapeHtml(item.status)}">${escapeHtml(statusLabel(item.status))}</span></span>
        <span><span class="fit-pill ${fitClass(item.fit_score)}">${typeof item.fit_score === 'number' ? `${Math.round(item.fit_score)}% fit` : 'Fit pending'}</span></span>
        <span class="application-meta application-date">${formatDate(item.updated_at || item.created_at)}</span>
        <span class="row-arrow">›</span>
    </button>`;
}

function filteredApplications() {
    const query = ($('#search-input').value || '').trim().toLowerCase();
    const statusValue = $('#status-filter').value;
    const statuses = statusValue === 'all' ? null : new Set(statusValue.split(','));
    let items = state.opportunities.filter((item) => {
        if (statusValue === 'all' && closedStatuses.has(item.status)) return false;
        if (statuses && !statuses.has(item.status)) return false;
        return !query || [item.company, item.role, item.platform].some((value) => String(value || '').toLowerCase().includes(query));
    });
    const sort = $('#sort-filter').value;
    items = [...items].sort((a, b) => {
        if (sort === 'fit_desc') return (b.fit_score ?? -1) - (a.fit_score ?? -1);
        if (sort === 'target_asc') return String(a.target_date || '9999').localeCompare(String(b.target_date || '9999'));
        return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
    return items;
}

function renderApplications() {
    if (!$('#search-input')) return;
    state.filtered = filteredApplications();
    $('#results-count').textContent = `${state.filtered.length} role${state.filtered.length === 1 ? '' : 's'}`;
    $('#applications-list').hidden = state.applicationLayout !== 'list';
    $('#pipeline-board').hidden = state.applicationLayout !== 'board';
    $('#applications-list').innerHTML = state.filtered.length ? state.filtered.map(applicationRow).join('') : '<div class="empty-state">No roles match these filters. Clear the filters or add a role.</div>';
    const stages = [
        ['Inbox', new Set(['draft','saved','preparing'])], ['Ready', new Set(['ready_to_review'])],
        ['Applied', new Set(['submitted','applied','no_response'])], ['Interview', new Set(['interview','negotiating'])],
        ['Offer', new Set(['offer'])], ['Closed', closedStatuses],
    ];
    const populated = stages.map(([label, statuses]) => [label, state.filtered.filter((item) => statuses.has(item.status))]).filter(([, items]) => items.length);
    $('#pipeline-board').innerHTML = populated.length ? populated.map(([label, items]) => `<section class="pipeline-column"><header><span>${label}</span><span>${items.length}</span></header>${items.map((item) => `<button class="pipeline-card" type="button" data-open-opportunity="${escapeHtml(item.id)}"><strong>${escapeHtml(item.company)}</strong><small>${escapeHtml(item.role)} · ${typeof item.fit_score === 'number' ? `${item.fit_score}% fit` : statusLabel(item.status)}</small></button>`).join('')}</section>`).join('') : '<div class="empty-state">No populated stages match this filter.</div>';
}

function boolSelect(value) { return value === true ? 'true' : value === false ? 'false' : ''; }
function profileCompletion() {
    const p = state.profile?.personal || {};
    const values = [p.first_name, p.last_name, p.email, p.phone, p.linkedin, (state.overview.resumes || []).length];
    return Math.round(values.filter(Boolean).length / values.length * 100);
}

function renderProfile() {
    const completion = profileCompletion();
    $('#profile-completeness').textContent = `${completion}%`;
    $('#profile-completeness-bar').style.width = `${completion}%`;
    $('#profile-completeness-copy').textContent = completion === 100 ? 'Your core contact details and resume are ready to reuse.' : 'Complete your contact details and upload a resume before preparing applications.';
    $('#nav-profile-state').textContent = completion === 100 ? 'Ready' : `${completion}%`;
    const p = state.profile?.personal || {};
    const preferences = state.profile?.preferences || {};
    const legal = state.profile?.legal || {};
    const form = $('#profile-form');
    form.elements.first_name.value = p.first_name || '';
    form.elements.last_name.value = p.last_name || '';
    form.elements.email.value = p.email || '';
    form.elements.phone.value = p.phone || '';
    form.elements.linkedin.value = p.linkedin || '';
    form.elements.salary_expectation.value = preferences.salary_expectation || '';
    form.elements.notice_period.value = preferences.notice_period || '';
    form.elements.authorized_to_work.value = boolSelect(legal.authorized_to_work);
    form.elements.sponsorship_required.value = boolSelect(legal.sponsorship_required);
    $('#knowledge-input').value = state.knowledge;

    const resumes = state.overview.resumes || [];
    $('#resume-list').innerHTML = resumes.length ? resumes.map((resume) => `<div class="asset-item"><div><strong>${escapeHtml(resume.label || resume.filename)}</strong><small>${resume.is_default ? 'Default for preparation' : `Created ${formatDate(resume.created_at)}`}</small></div><div class="asset-actions"><a href="/api/workspace/resume-versions/${encodeURIComponent(resume.id)}/download" target="_blank">PDF</a>${resume.is_default ? '' : `<button type="button" data-default-resume="${escapeHtml(resume.id)}">Make default</button>`}</div></div>`).join('') : '<div class="empty-state">Upload a PDF to create your master resume.</div>';
    const policies = state.overview.policies || [];
    $('#policy-list').innerHTML = policies.length ? policies.map((policy) => `<div class="policy-row"><div><strong>${escapeHtml(policy.label || policy.field_key)}</strong><small>${escapeHtml(policy.description || 'Choose how this field should be handled.')}</small></div><select data-policy-id="${escapeHtml(policy.id)}"><option value="always" ${['always','fill'].includes(policy.action) ? 'selected' : ''}>Always fill</option><option value="ask_every_time" ${['ask','ask_every_time'].includes(policy.action) ? 'selected' : ''}>Review each time</option><option value="never" ${['never','skip'].includes(policy.action) ? 'selected' : ''}>Never fill</option></select></div>`).join('') : '<div class="empty-state">No policies configured.</div>';
    renderAnswers();
}

function renderAnswers() {
    const query = ($('#answer-search').value || '').toLowerCase();
    const answers = (state.overview.answers || []).filter((item) => !query || `${item.question || ''} ${item.answer || ''}`.toLowerCase().includes(query));
    $('#answer-list').innerHTML = answers.length ? answers.map((item) => `<article class="answer-card"><div><h3>${escapeHtml(item.question)}</h3><textarea class="answer-edit" data-answer-value="${escapeHtml(item.id)}">${escapeHtml(item.answer)}</textarea><p class="answer-meta">${escapeHtml(item.company || 'Reusable answer')} · ${item.approved ? 'Approved for reuse' : 'Needs approval'}</p></div><div class="answer-actions"><button class="button secondary" type="button" data-save-answer="${escapeHtml(item.id)}">Save</button>${item.approved ? '' : `<button class="button primary" type="button" data-approve-answer="${escapeHtml(item.id)}">Approve</button>`}</div></article>`).join('') : '<div class="empty-state">No saved answers match this search.</div>';
}

function detailStatusOptions(current) {
    return ['saved','preparing','ready_to_review','submitted','applied','no_response','interview','negotiating','offer','accepted','rejected','withdrawn','archived'].map((status) => `<option value="${status}" ${current === status ? 'selected' : ''}>${statusLabel(status)}</option>`).join('');
}

function answerValue(answer) {
    const value = answer.value;
    return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
}

async function openDetail(id) {
    if (!id) return;
    state.selectedId = id;
    state.lastFocus = document.activeElement;
    const drawer = $('#detail-drawer');
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    $('#detail-content').innerHTML = '<div class="empty-state">Loading the application record…</div>';
    $('.icon-button', drawer).focus();
    try {
        const packet = await request(`/api/workspace/applications/${encodeURIComponent(id)}/packet`);
        renderDetail(packet);
    } catch (error) {
        $('#detail-content').innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
}

function renderDetail(packet) {
    const app = packet.application || packet.opportunity || {};
    $('#detail-title').textContent = `${app.company || 'Company'} · ${app.role || 'Role'}`;
    $('#detail-stage').textContent = statusLabel(app.status);
    const primary = safeUrl(app.url) ? `<a class="button primary" href="${escapeHtml(app.url)}" target="_blank" rel="noopener">${['saved','draft','preparing','ready_to_review'].includes(app.status) ? 'Open application' : 'Open posting'} ↗</a>` : '';
    const failures = packet.failures || [];
    const answers = packet.answers || [];
    const followUps = packet.follow_ups || [];
    const contacts = packet.contacts || [];
    const interviews = packet.interviews || [];
    const receipt = packet.receipt;
    $('#detail-content').innerHTML = `
        <div class="detail-hero"><div><span class="status-pill ${escapeHtml(app.status)}">${escapeHtml(statusLabel(app.status))}</span></div>${primary}</div>
        <div class="detail-stats"><div class="detail-stat"><span>Fit</span><strong>${typeof app.fit_score === 'number' ? `${app.fit_score}%` : 'Pending'}</strong></div><div class="detail-stat"><span>Platform</span><strong>${escapeHtml(app.platform || 'Direct')}</strong></div><div class="detail-stat"><span>Updated</span><strong>${formatDate(app.updated_at || app.created_at)}</strong></div></div>
        <nav class="detail-tabs" aria-label="Application details"><button class="active" data-detail-tab="overview" type="button">Overview</button><button data-detail-tab="preparation" type="button">Preparation${failures.length ? ` (${failures.length})` : ''}</button><button data-detail-tab="activity" type="button">Activity</button></nav>
        <section class="detail-pane active" data-detail-pane="overview">
            <form class="detail-section drawer-form" data-save-opportunity="${escapeHtml(app.id)}"><h3>Keep this record current</h3><div class="form-row"><label>Stage<select name="status">${detailStatusOptions(app.status)}</select></label><label>Target date<input name="target_date" type="date" value="${escapeHtml((app.target_date || '').slice(0,10))}"></label></div><label>Notes<textarea name="notes" rows="4" placeholder="Decision context, interview notes, or next step…">${escapeHtml(app.notes || '')}</textarea></label><button class="button secondary" type="submit">Save changes</button></form>
            <div class="detail-section"><h3>Job description</h3><p>${escapeHtml(packet.job_description || 'No clean job description has been captured yet.')}</p></div>
        </section>
        <section class="detail-pane" data-detail-pane="preparation">
            <div class="detail-section"><h3>Resume</h3>${packet.resume ? `<div class="detail-record"><div><strong>${escapeHtml(packet.resume.label || packet.resume.filename)}</strong><small>${packet.resume.is_default ? 'Default resume' : 'Selected for this role'}</small></div><a class="quiet-link" href="/api/workspace/resume-versions/${encodeURIComponent(packet.resume.id)}/download" target="_blank">Open PDF</a></div>` : '<p>No resume selected.</p>'}</div>
            <div class="detail-section"><h3>Prepared answers</h3>${answers.length ? answers.map((item) => `<div class="detail-record"><div><strong>${escapeHtml(item.question || item.field_key)}</strong><small>${escapeHtml(answerValue(item))}</small></div><span class="fit-pill ${item.confidence === 'high' ? 'high' : 'medium'}">${escapeHtml(item.source || 'Prepared')}</span></div>`).join('') : '<p>No prepared answers saved yet.</p>'}</div>
            <div class="detail-section"><h3>Fill failures</h3>${failures.length ? failures.map((item) => `<div class="detail-record failure-record"><div><strong>${escapeHtml(item.label || item.field_id || 'Field')}</strong><small>${escapeHtml(item.reason || 'Could not fill this field')}</small></div></div>`).join('') : '<p>No unresolved fill failures.</p>'}</div>
        </section>
        <section class="detail-pane" data-detail-pane="activity">
            <div class="detail-section"><h3>Submission receipt</h3>${receipt ? `<div class="detail-record receipt-record"><div><strong>Submission recorded</strong><small>${formatDate(receipt.submitted_at, true)}${receipt.confirmation_code ? ` · ${escapeHtml(receipt.confirmation_code)}` : ''}</small></div></div>` : '<p>No receipt recorded. AutoApply records one only after you confirm submission from the application page.</p>'}</div>
            <div class="detail-section"><h3>Follow-ups</h3>${followUps.length ? followUps.map((item) => `<div class="detail-record"><div><strong>${escapeHtml(item.notes || 'Follow up')}</strong><small>${formatDate(item.due_at, true)}${item.completed_at ? ' · Completed' : ''}</small></div>${item.completed_at ? '' : `<button class="quiet-link" type="button" data-complete-followup="${escapeHtml(item.id)}">Mark done</button>`}</div>`).join('') : '<p>No follow-ups scheduled.</p>'}<form class="drawer-form" data-add-followup="${escapeHtml(app.id)}"><div class="form-row"><label>Due<input name="due_at" type="datetime-local" required></label><label>Reminder<input name="note" required placeholder="Send a concise follow-up"></label></div><button class="button secondary" type="submit">Schedule follow-up</button></form></div>
            <div class="detail-section"><h3>Contacts & interviews</h3>${[...contacts,...interviews].length ? [...contacts,...interviews].map((item) => `<div class="detail-record"><div><strong>${escapeHtml(item.name || (item.interviewer_names || []).join(', ') || item.interview_type || 'Interview')}</strong><small>${item.scheduled_at ? formatDate(item.scheduled_at, true) : escapeHtml(item.relationship || 'Contact')}</small></div></div>`).join('') : '<p>No people or interviews recorded.</p>'}<form class="drawer-form" data-add-relationship="${escapeHtml(app.id)}"><div class="form-row"><label>Name<input name="name" required placeholder="Recruiter or interviewer"></label><label>Type<select name="type"><option value="contact">Contact</option><option value="interview">Interview</option></select></label></div><button class="button secondary" type="submit">Add relationship</button></form></div>
        </section>`;
}

function closeDetail() {
    const drawer = $('#detail-drawer');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    state.lastFocus?.focus?.();
}

function setActiveView(view) {
    state.activeView = view;
    $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    $$('.workspace-view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
    $('#current-view-label').textContent = ({ today:'Today', applications:'Applications', profile:'Profile & assets' })[view];
    history.replaceState(null, '', `#${view}`);
    window.scrollTo({ top:0, behavior:'smooth' });
}

async function saveOpportunity(payload, resolution = 'create_new', existingId = null) {
    const body = { ...payload, duplicate_resolution:resolution };
    if (existingId) body.existing_id = existingId;
    await request('/api/workspace/opportunities/upsert', { method:'POST', body:JSON.stringify(body) });
    $('#add-job-dialog').close();
    state.duplicatePayload = null;
    toast(resolution === 'reuse' ? 'Opened the tracked application.' : 'Role added to your workspace.');
    await loadData();
    setActiveView('applications');
}

function resetAddJobDialog() {
    $('#add-job-form').reset();
    $('#duplicate-choice').hidden = true;
    $('#duplicate-choice').innerHTML = '';
    $('#add-job-fields').hidden = false;
    $('#add-job-submit').hidden = false;
    state.duplicatePayload = null;
}

function openAddJob(trigger) {
    resetAddJobDialog();
    state.addJobFocus = trigger;
    $('#add-job-dialog').showModal();
}

function closeAddJob() {
    const dialog = $('#add-job-dialog');
    if (dialog.open) dialog.close();
}

document.addEventListener('click', async (event) => {
    const view = event.target.closest('[data-view]');
    if (view) return setActiveView(view.dataset.view);
    const openView = event.target.closest('[data-open-view]');
    if (openView) return setActiveView(openView.dataset.openView);
    const addJob = event.target.closest('[data-open-add-job]');
    if (addJob) return openAddJob(addJob);
    if (event.target.closest('[data-close-add-job]')) return closeAddJob();
    if (event.target.closest('[data-close-detail]')) return closeDetail();
    const opportunity = event.target.closest('[data-open-opportunity]');
    if (opportunity) return openDetail(opportunity.dataset.openOpportunity);
    const tab = event.target.closest('[data-detail-tab]');
    if (tab) { $$('.detail-tabs button').forEach((item) => item.classList.toggle('active', item === tab)); $$('.detail-pane').forEach((pane) => pane.classList.toggle('active', pane.dataset.detailPane === tab.dataset.detailTab)); return; }
    const layout = event.target.closest('[data-app-layout]');
    if (layout) { state.applicationLayout = layout.dataset.appLayout; $$('[data-app-layout]').forEach((item) => item.classList.toggle('active', item === layout)); return renderApplications(); }
    const resume = event.target.closest('[data-default-resume]');
    if (resume) { try { await request(`/api/workspace/resume-versions/${encodeURIComponent(resume.dataset.defaultResume)}`, { method:'PATCH', body:JSON.stringify({ is_default:true }) }); toast('Default resume updated.'); await loadData(); } catch (error) { toast(error.message, true); } return; }
    const approve = event.target.closest('[data-approve-answer]');
    if (approve) { try { await request(`/api/workspace/answer-vault/${encodeURIComponent(approve.dataset.approveAnswer)}`, { method:'PATCH', body:JSON.stringify({ approved:true }) }); toast('Answer approved for reuse.'); await loadData(); } catch (error) { toast(error.message, true); } return; }
    const saveAnswer = event.target.closest('[data-save-answer]');
    if (saveAnswer) { const value = $(`[data-answer-value="${CSS.escape(saveAnswer.dataset.saveAnswer)}"]`).value.trim(); try { await request(`/api/workspace/answer-vault/${encodeURIComponent(saveAnswer.dataset.saveAnswer)}`, { method:'PATCH', body:JSON.stringify({ answer:value }) }); toast('Answer updated.'); await loadData(); } catch (error) { toast(error.message, true); } return; }
    const complete = event.target.closest('[data-complete-followup]');
    if (complete) { try { await request(`/api/workspace/follow-ups/${encodeURIComponent(complete.dataset.completeFollowup)}`, { method:'PATCH', body:JSON.stringify({ completed:true }) }); toast('Follow-up completed.'); await loadData(); await openDetail(state.selectedId); } catch (error) { toast(error.message, true); } return; }
    const reuse = event.target.closest('[data-reuse-opportunity]');
    if (reuse) { try { await saveOpportunity(state.duplicatePayload, 'reuse', reuse.dataset.reuseOpportunity); } catch (error) { toast(error.message, true); } return; }
    if (event.target.closest('[data-create-duplicate]')) { try { await saveOpportunity(state.duplicatePayload, 'create_new'); } catch (error) { toast(error.message, true); } }
});

document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (form.matches('[data-save-opportunity]')) {
        event.preventDefault(); const data = new FormData(form);
        try { await request(`/api/workspace/opportunities/${encodeURIComponent(form.dataset.saveOpportunity)}`, { method:'PATCH', body:JSON.stringify({ status:data.get('status'), target_date:data.get('target_date') || null, notes:data.get('notes') }) }); toast('Application updated.'); await loadData(); await openDetail(form.dataset.saveOpportunity); } catch (error) { toast(error.message, true); }
    }
    if (form.matches('[data-add-followup]')) {
        event.preventDefault(); const data = new FormData(form);
        try { await request(`/api/workspace/applications/${encodeURIComponent(form.dataset.addFollowup)}/follow-ups`, { method:'POST', body:JSON.stringify({ due_at:new Date(data.get('due_at')).toISOString(), note:data.get('note') }) }); toast('Follow-up scheduled.'); await loadData(); await openDetail(form.dataset.addFollowup); } catch (error) { toast(error.message, true); }
    }
    if (form.matches('[data-add-relationship]')) {
        event.preventDefault(); const data = new FormData(form);
        try { await request(`/api/workspace/applications/${encodeURIComponent(form.dataset.addRelationship)}/relationships`, { method:'POST', body:JSON.stringify({ name:data.get('name'), type:data.get('type') }) }); toast('Relationship added.'); await loadData(); await openDetail(form.dataset.addRelationship); } catch (error) { toast(error.message, true); }
    }
});

$('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const optionalBool = (name) => data.get(name) === '' ? null : data.get(name) === 'true';
    const payload = { personal:{ first_name:data.get('first_name') || null, last_name:data.get('last_name') || null, email:data.get('email') || null, phone:data.get('phone') || null, linkedin:data.get('linkedin') || null }, preferences:{ salary_expectation:data.get('salary_expectation') || null, notice_period:data.get('notice_period') || null }, legal:{ authorized_to_work:optionalBool('authorized_to_work'), sponsorship_required:optionalBool('sponsorship_required') } };
    try { await request('/api/profile/', { method:'PUT', body:JSON.stringify(payload) }); toast('Profile saved.'); await loadData(); } catch (error) { toast(error.message, true); }
});

$('#knowledge-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await request('/api/profile/upload-knowledge', { method:'POST', body:JSON.stringify({ content:$('#knowledge-input').value }) }); toast('Application notes saved.'); state.knowledge = $('#knowledge-input').value; } catch (error) { toast(error.message, true); } });
$('#policy-form').addEventListener('submit', async (event) => { event.preventDefault(); const policies = $$('[data-policy-id]').map((select) => ({ id:select.dataset.policyId, enabled:true, action:select.value })); try { await request('/api/workspace/policies', { method:'PUT', body:JSON.stringify({ policies }) }); toast('Review policy saved.'); await loadData(); } catch (error) { toast(error.message, true); } });
$('#resume-upload').addEventListener('change', async (event) => { const file = event.target.files[0]; if (!file) return; const body = new FormData(); body.append('file', file); try { toast('Uploading and parsing resume…'); await request('/api/profile/upload-resume', { method:'POST', body }); toast('Resume uploaded and profile updated.'); event.target.value = ''; await loadData(); } catch (error) { toast(error.message, true); } });

$('#add-job-form').addEventListener('submit', async (event) => {
    if (event.submitter?.value === 'cancel') return;
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = { url:data.get('url'), company:data.get('company'), role:data.get('role'), target_date:data.get('target_date') || null, status:'saved', source:'dashboard' };
    state.duplicatePayload = payload;
    try {
        const query = new URLSearchParams({ url:payload.url, company:payload.company, role:payload.role });
        const duplicates = await request(`/api/workspace/duplicates?${query}`);
        if (!duplicates.matches?.length) return saveOpportunity(payload, 'create_new');
        $('#add-job-fields').hidden = true; $('#add-job-submit').hidden = true; $('#duplicate-choice').hidden = false;
        $('#duplicate-choice').innerHTML = `<h3>This role may already be tracked.</h3><p>Open an existing record or keep this as another attempt.</p>${duplicates.matches.map((item) => `<div class="duplicate-match"><div><strong>${escapeHtml(item.company)} · ${escapeHtml(item.role)}</strong><small>${escapeHtml(item.match_reason)} · ${statusLabel(item.status)}</small></div><button class="button secondary" type="button" data-reuse-opportunity="${escapeHtml(item.id)}">Open tracked</button></div>`).join('')}<button class="quiet-link" type="button" data-create-duplicate>Create another attempt</button>`;
    } catch (error) { toast(error.message, true); }
});

$('#search-input').addEventListener('input', renderApplications);
$('#status-filter').addEventListener('change', renderApplications);
$('#sort-filter').addEventListener('change', renderApplications);
$('#answer-search').addEventListener('input', renderAnswers);
$('#theme-select').addEventListener('change', (event) => applyTheme(event.currentTarget.value));
$('#refresh-btn').addEventListener('click', loadData);
$('#export-csv-btn').addEventListener('click', () => { window.location.href = '/api/applications/export'; });

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('#add-job-dialog').open) {
        event.preventDefault();
        closeAddJob();
        return;
    }
    if (event.key === 'Escape' && $('#detail-drawer').classList.contains('open')) closeDetail();
    if (event.key === 'Tab' && $('#detail-drawer').classList.contains('open')) {
        const focusable = $$('button:not([disabled]),a[href],input,select,textarea', $('.drawer-panel')).filter((item) => item.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
});

$('#add-job-dialog').addEventListener('close', () => {
    resetAddJobDialog();
    state.addJobFocus?.focus?.();
    state.addJobFocus = null;
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') applyTheme('system', false);
});

const initialView = location.hash.slice(1);
if (['today','applications','profile'].includes(initialView)) setActiveView(initialView);
applyTheme(localStorage.getItem(THEME_KEY) || 'system', false);
loadData();
