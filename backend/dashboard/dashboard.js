// State management
let applications = [];
let filteredApplications = [];

// DOM Elements
const appsTbody = document.getElementById('apps-tbody');
const searchInput = document.getElementById('search-input');
const statusFilter = document.getElementById('status-filter');
const dateFilter = document.getElementById('date-filter');
const exportCsvBtn = document.getElementById('export-csv-btn');

// Stats DOM Elements
const statTotal = document.getElementById('stat-total');
const statWeek = document.getElementById('stat-week');
const statInterviews = document.getElementById('stat-interviews');
const statOffers = document.getElementById('stat-offers');
const statFit = document.getElementById('stat-fit');
const toastEl = document.getElementById('toast');

// API Helpers
const API_BASE = '';

async function fetchApplications() {
    try {
        const response = await fetch(`${API_BASE}/api/applications/?limit=500`);
        if (!response.ok) throw new Error('Failed to fetch applications');
        applications = await response.json();
        applyFilters();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        appsTbody.innerHTML = `
            <tr>
                <td colspan="7" class="empty-state">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    Failed to load applications. Please make sure the backend is running.
                </td>
            </tr>
        `;
    }
}

function calculateStats(appsList) {
    // 1. Total Applications
    statTotal.textContent = appsList.length;

    // 2. Applied This Week (last 7 days)
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const thisWeekApps = appsList.filter(app => {
        if (!app.applied_at) return false;
        const appDate = new Date(app.applied_at);
        return appDate >= oneWeekAgo;
    });
    statWeek.textContent = thisWeekApps.length;

    // 3. Interview Count
    const interviews = appsList.filter(app => app.status === 'interview');
    statInterviews.textContent = interviews.length;

    // 4. Offer Count
    const offers = appsList.filter(app => app.status === 'offer');
    statOffers.textContent = offers.length;

    // 5. Avg Fit Score
    const scoredApps = appsList.filter(app => typeof app.fit_score === 'number');
    if (scoredApps.length > 0) {
        const totalScore = scoredApps.reduce((sum, app) => sum + app.fit_score, 0);
        statFit.textContent = `${Math.round(totalScore / scoredApps.length)}%`;
    } else {
        statFit.textContent = 'N/A';
    }
}

function renderApplicationsTable() {
    if (filteredApplications.length === 0) {
        appsTbody.innerHTML = `
            <tr>
                <td colspan="7" class="empty-state">
                    <i class="fa-solid fa-folder-open"></i>
                    No applications found matching the criteria.
                </td>
            </tr>
        `;
        return;
    }

    appsTbody.innerHTML = '';
    filteredApplications.forEach(app => {
        // Formatted Date
        let formattedDate = 'N/A';
        if (app.applied_at) {
            const dateObj = new Date(app.applied_at);
            formattedDate = dateObj.toLocaleDateString(undefined, { 
                month: 'short', 
                day: 'numeric', 
                year: 'numeric' 
            });
        }

        let safeUrl = '#';
        if (app.url && (app.url.startsWith('http://') || app.url.startsWith('https://'))) {
            safeUrl = escapeHtml(app.url);
        }

        // Fit Score Badge Info
        let fitClass = 'unknown';
        let fitText = 'N/A';
        if (typeof app.fit_score === 'number') {
            fitText = `${app.fit_score}%`;
            if (app.fit_score >= 80) fitClass = 'high';
            else if (app.fit_score >= 50) fitClass = 'medium';
            else fitClass = 'low';
        }

        // Create main row
        const row = document.createElement('tr');
        row.className = 'app-row';
        row.dataset.id = app.id;
        row.innerHTML = `
            <td class="app-date">${formattedDate}</td>
            <td class="app-company">${escapeHtml(app.company)}</td>
            <td class="app-role">${escapeHtml(app.role)}</td>
            <td><span class="app-platform">${escapeHtml(app.platform || 'Direct')}</span></td>
            <td><span class="fit-badge ${fitClass}">${fitText}</span></td>
            <td>
                <select class="status-select ${app.status}" data-id="${app.id}">
                    <option value="applied" ${app.status === 'applied' ? 'selected' : ''}>Applied</option>
                    <option value="interview" ${app.status === 'interview' ? 'selected' : ''}>Interview</option>
                    <option value="rejected" ${app.status === 'rejected' ? 'selected' : ''}>Rejected</option>
                    <option value="offer" ${app.status === 'offer' ? 'selected' : ''}>Offer</option>
                    <option value="withdrawn" ${app.status === 'withdrawn' ? 'selected' : ''}>Withdrawn</option>
                </select>
            </td>
            <td>
                <a href="${safeUrl}" target="_blank" class="action-btn url-link" title="Open Job URL" onclick="event.stopPropagation();">
                    <i class="fa-solid fa-arrow-up-right-from-square"></i>
                </a>
                <button class="action-btn toggle-details-btn" title="Toggle Details">
                    <i class="fa-solid fa-chevron-down"></i>
                </button>
            </td>
        `;

        // Create detail row
        const detailRow = document.createElement('tr');
        detailRow.className = 'details-row';
        detailRow.dataset.id = app.id;
        detailRow.innerHTML = `
            <td colspan="7">
                <div class="details-wrapper">
                    <div class="details-content">
                        <div class="details-jd">
                            <h4>Job Description Snippet</h4>
                            <p>${escapeHtml(app.job_description_snippet || 'No job description snippet available.')}</p>
                        </div>
                        <div class="details-notes">
                            <h4>Application Notes</h4>
                            <div class="notes-editor">
                                <textarea class="notes-textarea" placeholder="Add interviews dates, contact persons, follow-up notes...">${escapeHtml(app.notes || '')}</textarea>
                                <button class="btn btn-secondary btn-save-notes" data-id="${app.id}">
                                    <i class="fa-solid fa-floppy-disk"></i> Save Notes
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </td>
        `;

        appsTbody.appendChild(row);
        appsTbody.appendChild(detailRow);

        // Click event to toggle details
        row.addEventListener('click', (e) => {
            if (e.target.closest('.status-select')) return; // Ignore dropdown changes
            toggleDetails(app.id);
        });

        // Dropdown status change
        const statusSelect = row.querySelector('.status-select');
        statusSelect.addEventListener('change', async (e) => {
            const newStatus = e.target.value;
            // Update class for colors
            statusSelect.className = `status-select ${newStatus}`;
            await updateApplicationStatus(app.id, newStatus, null);
        });

        // Save notes button click
        const saveNotesBtn = detailRow.querySelector('.btn-save-notes');
        const notesTextarea = detailRow.querySelector('.notes-textarea');
        saveNotesBtn.addEventListener('click', async () => {
            const notesValue = notesTextarea.value;
            // We need to keep the current status when updating notes
            const currentStatus = statusSelect.value;
            await updateApplicationStatus(app.id, currentStatus, notesValue);
        });
    });
}

function toggleDetails(appId) {
    const detailRow = appsTbody.querySelector(`.details-row[data-id="${appId}"]`);
    const mainRow = appsTbody.querySelector(`.app-row[data-id="${appId}"]`);
    const chevronIcon = mainRow.querySelector('.toggle-details-btn i');

    if (!detailRow || !mainRow) return;

    const isShowing = detailRow.classList.contains('show');
    
    // Collapse all other detail rows
    appsTbody.querySelectorAll('.details-row.show').forEach(row => {
        if (row.dataset.id !== appId) {
            row.classList.remove('show');
            const otherMainRow = appsTbody.querySelector(`.app-row[data-id="${row.dataset.id}"]`);
            if (otherMainRow) {
                otherMainRow.classList.remove('expanded');
                otherMainRow.querySelector('.toggle-details-btn i').className = 'fa-solid fa-chevron-down';
            }
        }
    });

    if (isShowing) {
        detailRow.classList.remove('show');
        mainRow.classList.remove('expanded');
        chevronIcon.className = 'fa-solid fa-chevron-down';
    } else {
        detailRow.classList.add('show');
        mainRow.classList.add('expanded');
        chevronIcon.className = 'fa-solid fa-chevron-up';
    }
}

async function updateApplicationStatus(appId, status, notes) {
    try {
        const body = { status };
        if (notes !== null) {
            body.notes = notes;
        }

        const response = await fetch(`${API_BASE}/api/applications/${appId}/status`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) throw new Error('Failed to update status');
        
        // Update local state
        const appIdx = applications.findIndex(a => a.id === appId);
        if (appIdx !== -1) {
            applications[appIdx].status = status;
            if (notes !== null) {
                applications[appIdx].notes = notes;
            }
        }

        calculateStats(applications);
        showToast('Application updated successfully!', 'success');
    } catch (error) {
        showToast(`Failed to update application: ${error.message}`, 'error');
    }
}

function applyFilters() {
    const searchQuery = searchInput.value.toLowerCase().trim();
    const statusVal = statusFilter.value;
    const dateVal = dateFilter.value;

    filteredApplications = applications.filter(app => {
        // 1. Search filter
        const matchesSearch = !searchQuery || 
            (app.company && app.company.toLowerCase().includes(searchQuery)) ||
            (app.role && app.role.toLowerCase().includes(searchQuery)) ||
            (app.platform && app.platform.toLowerCase().includes(searchQuery));

        // 2. Status filter
        const matchesStatus = statusVal === 'all' || app.status === statusVal;

        // 3. Date range filter
        let matchesDate = true;
        if (dateVal !== 'all' && app.applied_at) {
            const appDate = new Date(app.applied_at);
            const now = new Date();
            const diffTime = Math.abs(now - appDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

            if (dateVal === 'today') {
                matchesDate = diffDays <= 1;
            } else if (dateVal === 'week') {
                matchesDate = diffDays <= 7;
            } else if (dateVal === 'month') {
                matchesDate = diffDays <= 30;
            }
        }

        return matchesSearch && matchesStatus && matchesDate;
    });

    calculateStats(applications); // Always calculate stats on the full set
    renderApplicationsTable();
}

// Toast System
let toastTimeout;
function showToast(message, type = 'success') {
    clearTimeout(toastTimeout);
    toastEl.className = `toast show ${type}`;
    toastEl.innerHTML = type === 'success' 
        ? `<i class="fa-solid fa-circle-check"></i> ${escapeHtml(message)}`
        : `<i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(message)}`;

    toastTimeout = setTimeout(() => {
        toastEl.classList.remove('show');
    }, 3000);
}

// Helper to escape HTML characters
function escapeHtml(unsafe) {
    if (!unsafe) return '';
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Event Listeners
searchInput.addEventListener('input', applyFilters);
statusFilter.addEventListener('change', applyFilters);
dateFilter.addEventListener('change', applyFilters);

exportCsvBtn.addEventListener('click', () => {
    // Point the CSV export directly to the backend endpoint
    window.location.href = `${API_BASE}/api/applications/export`;
});

// Initial Load
document.addEventListener('DOMContentLoaded', fetchApplications);
