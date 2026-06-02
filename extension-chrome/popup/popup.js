/**
 * AutoApply — Popup UI Logic
 * Runs inside the browser action popup. Handles user profile setup,
 * backend connection health status, and starting the autofill scanner.
 */

document.addEventListener('DOMContentLoaded', () => {
  const UTILS = window.__autoapply_utils;

  // DOM Elements
  const tabDashboard = document.getElementById('tab-dashboard');
  const tabProfile = document.getElementById('tab-profile');
  const tabBatch = document.getElementById('tab-batch');
  const sectDashboard = document.getElementById('sect-dashboard');
  const sectProfile = document.getElementById('sect-profile');
  const sectBatch = document.getElementById('sect-batch');
  
  const backendStatus = document.getElementById('backend-status');
  const statusDot = backendStatus.querySelector('.status-dot');
  const statusText = backendStatus.querySelector('.status-text');
  
  const chkResume = document.getElementById('chk-resume');
  const chkKnowledge = document.getElementById('chk-knowledge');
  const startBtn = document.getElementById('start-autofill');
  const recentAppsList = document.getElementById('recent-apps-list');
  
  const resumeDropZone = document.getElementById('resume-drop-zone');
  const resumeFileInput = document.getElementById('resume-file-input');
  const resumeUploadStatus = document.getElementById('resume-upload-status');
  
  const knowledgeInput = document.getElementById('knowledge-input');
  const saveKnowledgeBtn = document.getElementById('save-knowledge-btn');
  
  const profileName = document.getElementById('profile-name');
  const profileEmail = document.getElementById('profile-email');
  const profilePhone = document.getElementById('profile-phone');
  const profileSkillsCount = document.getElementById('profile-skills-count');
  const openFullTabBtn = document.getElementById('open-full-tab-btn');
  
  const batchUrlsInput = document.getElementById('batch-urls-input');
  const startBatchBtn = document.getElementById('start-batch-btn');
  const batchStatusLog = document.getElementById('batch-status-log');
  const batchStatusSection = document.querySelector('.batch-status-section');
  
  const footerMsg = document.getElementById('footer-msg');

  let backendConnected = false;
  let profileLoaded = false;

  // ═══════════════════════════════════════════
  // Tab Switching Logic
  // ═══════════════════════════════════════════
  tabDashboard.addEventListener('click', () => {
    tabDashboard.classList.add('active');
    tabProfile.classList.remove('active');
    tabBatch.classList.remove('active');
    sectDashboard.classList.add('active');
    sectProfile.classList.remove('active');
    sectBatch.classList.remove('active');
    refreshDashboard();
  });

  tabProfile.addEventListener('click', () => {
    tabProfile.classList.add('active');
    tabDashboard.classList.remove('active');
    tabBatch.classList.remove('active');
    sectProfile.classList.add('active');
    sectDashboard.classList.remove('active');
    sectBatch.classList.remove('active');
    loadProfileDetails();
  });

  tabBatch.addEventListener('click', () => {
    tabBatch.classList.add('active');
    tabDashboard.classList.remove('active');
    tabProfile.classList.remove('active');
    sectBatch.classList.add('active');
    sectDashboard.classList.remove('active');
    sectProfile.classList.remove('active');
  });

  // ═══════════════════════════════════════════
  // Health Check & State Synchronization
  // ═══════════════════════════════════════════
  async function checkBackendHealth() {
    try {
      const status = await UTILS.apiCall('/api/health');
      
      backendConnected = true;
      backendStatus.className = 'status-indicator connected';
      statusText.textContent = 'Backend Active';

      // Update checklists based on health response
      profileLoaded = status.profile_loaded;
      
      updateChecklistItem(chkResume, status.profile_loaded);
      updateChecklistItem(chkKnowledge, status.knowledge_loaded);

      // Verify if active tab is a web page we can scan
      const activeTabs = await browser.tabs.query({ active: true, currentWindow: true });
      const currentTab = activeTabs[0];
      const isValidPage = currentTab && currentTab.url && (currentTab.url.startsWith('http://') || currentTab.url.startsWith('https://'));

      if (!status.profile_loaded) {
        startBtn.disabled = true;
        startBtn.querySelector('small').textContent = 'Please upload a resume in the Profile tab';
        startBatchBtn.disabled = true;
      } else if (!isValidPage) {
        startBtn.disabled = true;
        startBtn.querySelector('small').textContent = 'Navigate to a job application form to start';
        startBatchBtn.disabled = false;
      } else {
        startBtn.disabled = false;
        startBtn.querySelector('small').textContent = 'Autofill the application form on this page';
        startBatchBtn.disabled = false;
      }

      showFooterMessage('Ready');
      return status;
    } catch (err) {
      console.error('[AutoApply] Backend connection failed:', err);
      backendConnected = false;
      profileLoaded = false;
      backendStatus.className = 'status-indicator disconnected';
      statusText.textContent = 'Offline';
      
      updateChecklistItem(chkResume, false);
      updateChecklistItem(chkKnowledge, false);
      
      startBtn.disabled = true;
      startBtn.querySelector('small').textContent = 'Start the local FastAPI server';
      startBatchBtn.disabled = true;

      showFooterMessage('Cannot connect to local backend (port 8000)');
      return null;
    }
  }

  function updateChecklistItem(el, isDone) {
    if (isDone) {
      el.classList.add('done');
      el.querySelector('.chk-icon').textContent = '✓';
    } else {
      el.classList.remove('done');
      el.querySelector('.chk-icon').textContent = '○';
    }
  }

  function showFooterMessage(text) {
    footerMsg.textContent = text;
  }

  // ═══════════════════════════════════════════
  // Dashboard Logic
  // ═══════════════════════════════════════════
  async function refreshDashboard() {
    const health = await checkBackendHealth();
    if (health) {
      loadRecentApplications();
    } else {
      recentAppsList.innerHTML = '<div class="no-apps-msg">Backend offline. Please start local backend server.</div>';
    }
  }

  function loadRecentApplications() {
    // Call recent apps message to background script
    browser.runtime.sendMessage({ type: 'GET_RECENT_APPS' })
      .then(response => {
        if (response.status === 'success' && response.data && response.data.length > 0) {
          renderRecentApplications(response.data);
        } else {
          recentAppsList.innerHTML = '<div class="no-apps-msg">No job applications logged in this session yet.</div>';
        }
      })
      .catch(err => {
        console.error('Failed to get applications:', err);
        recentAppsList.innerHTML = '<div class="no-apps-msg">Failed to load application history.</div>';
      });
  }

  function renderRecentApplications(apps) {
    recentAppsList.innerHTML = apps.map(app => {
      const dateStr = app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '';
      const scoreBadge = app.fit_score 
        ? `<span class="app-score">${app.fit_score}% Fit</span>`
        : '';
      return `
        <div class="app-card">
          <div class="app-info">
            <div class="app-role">${AutoApplyUtils.escapeHTML(app.role)}</div>
            <div class="app-company">${AutoApplyUtils.escapeHTML(app.company)}</div>
          </div>
          <div class="app-meta">
            ${scoreBadge}
            <span class="app-status-badge">${AutoApplyUtils.escapeHTML(app.status)}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // Trigger autofill action
  startBtn.addEventListener('click', () => {
    showFooterMessage('Activating overlay...');
    browser.runtime.sendMessage({ type: 'START_AUTOFILL' })
      .then(response => {
        if (response.status === 'success') {
          window.close(); // Close popup
        } else {
          showFooterMessage(`Error: ${response.error || 'Check extension status'}`);
        }
      })
      .catch(err => {
        showFooterMessage(`Failed to trigger overlay: ${err.message}`);
      });
  });

  // ═══════════════════════════════════════════
  // Profile & Resume Uploads
  // ═══════════════════════════════════════════
  async function loadProfileDetails() {
    if (!backendConnected) {
      showFooterMessage('Connect backend to edit profile');
      return;
    }

    // Prepopulate knowledge from backend
    try {
      const data = await UTILS.apiCall('/api/profile/knowledge');
      knowledgeInput.value = data.content || '';
    } catch (err) {
      console.warn('Could not load knowledge:', err);
    }

    // Load structured details
    try {
      const profile = await UTILS.apiCall('/api/profile');
      profileName.textContent = `Name: ${profile.personal?.first_name || ''} ${profile.personal?.last_name || ''}`.trim() || 'Name: —';
      profileEmail.textContent = `Email: ${profile.personal?.email || '—'}`;
      profilePhone.textContent = `Phone: ${profile.personal?.phone || '—'}`;
      
      const skillsCount = profile.skills ? profile.skills.length : 0;
      profileSkillsCount.textContent = `Skills: ${skillsCount} extracted`;
      resumeUploadStatus.textContent = 'Active PDF resume uploaded';
    } catch (err) {
      // Profile not created yet
      profileName.textContent = 'Name: Not Extracted';
      profileEmail.textContent = 'Email: —';
      profilePhone.textContent = 'Phone: —';
      profileSkillsCount.textContent = 'Skills: —';
      resumeUploadStatus.textContent = 'No resume uploaded yet';
    }
  }

  // Open Full Tab
  if (openFullTabBtn) {
    openFullTabBtn.addEventListener('click', () => {
      browser.tabs.create({ url: browser.runtime.getURL("popup/popup.html") });
    });
  }

  // File Upload Handlers
  resumeDropZone.addEventListener('click', () => {
    resumeFileInput.click();
  });

  resumeFileInput.addEventListener('change', () => {
    if (resumeFileInput.files.length > 0) {
      handleResumeUpload(resumeFileInput.files[0]);
    }
  });

  // Drag and drop events
  ['dragenter', 'dragover'].forEach(eventName => {
    resumeDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      resumeDropZone.style.borderColor = 'var(--accent-color)';
      resumeDropZone.style.background = 'rgba(102, 126, 234, 0.05)';
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    resumeDropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      resumeDropZone.style.borderColor = '';
      resumeDropZone.style.background = '';
    }, false);
  });

  resumeDropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0 && files[0].name.toLowerCase().endsWith('.pdf')) {
      handleResumeUpload(files[0]);
    } else {
      showFooterMessage('Error: Only PDF resumes are accepted.');
    }
  });

  async function handleResumeUpload(file) {
    showFooterMessage('Uploading & parsing resume via Gemini...');
    resumeUploadStatus.textContent = 'Uploading...';
    
    const formData = new FormData();
    formData.append('file', file);

    const url = `${UTILS.API_BASE}/api/profile/upload-resume`;
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`Server returned code ${response.status}`);
      }

      const resData = await response.json();
      showFooterMessage('Resume parsed successfully!');
      loadProfileDetails();
      checkBackendHealth();
    } catch (err) {
      console.error('[AutoApply] Resume upload failed:', err);
      showFooterMessage(`Upload failed: ${err.message}`);
      resumeUploadStatus.textContent = 'Upload failed. Try again.';
    }
  }

  // Save Knowledge File
  saveKnowledgeBtn.addEventListener('click', async () => {
    if (!backendConnected) {
      showFooterMessage('Backend offline. Cannot save.');
      return;
    }

    const content = knowledgeInput.value;
    showFooterMessage('Saving knowledge file...');

    try {
      const res = await UTILS.apiCall('/api/profile/upload-knowledge', 'POST', { content: content });
      showFooterMessage('Knowledge file saved successfully!');
      checkBackendHealth();
    } catch (err) {
      console.error('Failed to save knowledge:', err);
      showFooterMessage(`Failed to save: ${err.message}`);
    }
  });

  // ═══════════════════════════════════════════
  // Batch Apply Logic
  // ═══════════════════════════════════════════
  async function startBatchApply(urls) {
    for (let i = 0; i < urls.length; i++) {
      updateBatchProgress(i, urls.length, urls[i], 'opening...');
      
      // Open URL in a new tab
      let tab;
      try {
        tab = await browser.tabs.create({ url: urls[i], active: true });
      } catch (err) {
        updateBatchProgress(i, urls.length, urls[i], `failed to open tab: ${err.message}`);
        continue;
      }
      
      // Wait for page to load completely
      await new Promise(resolve => {
        function listener(tabId, info) {
          if (tabId === tab.id && info.status === 'complete') {
            browser.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        }
        browser.tabs.onUpdated.addListener(listener);
        // Fallback timeout in case event is missed or tab takes too long (e.g. 30s)
        setTimeout(() => {
          browser.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 30000);
      });
      
      // Wait a bit for content scripts to inject and DOM to settle
      await new Promise(r => setTimeout(r, 2000));
      
      updateBatchProgress(i, urls.length, urls[i], 'running AutoPilot...');
      
      // Send START_AUTOPILOT message to the tab
      try {
        await browser.tabs.sendMessage(tab.id, { type: 'START_AUTOPILOT' });
      } catch (err) {
        updateBatchProgress(i, urls.length, urls[i], `failed: ${err.message}`);
        continue;
      }
      
      // Wait for AutoPilot to complete (poll status)
      await new Promise(resolve => {
        const checkInterval = setInterval(async () => {
          try {
            const status = await browser.tabs.sendMessage(tab.id, { type: 'GET_AUTOPILOT_STATUS' });
            if (!status || !status.autopilotActive) {
              clearInterval(checkInterval);
              resolve();
            } else {
              updateBatchProgress(i, urls.length, urls[i], `running AutoPilot (page ${status.autopilotStep || 1})...`);
            }
          } catch {
            // If tab was closed or communications failed, assume autopilot stopped
            clearInterval(checkInterval);
            resolve();
          }
        }, 3000);
        // Timeout after 5 minutes
        setTimeout(() => { clearInterval(checkInterval); resolve(); }, 300000);
      });
      
      updateBatchProgress(i, urls.length, urls[i], 'done');
      
      // Small delay between applications
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  function updateBatchProgress(index, total, url, statusText) {
    batchStatusSection.style.display = 'block';
    
    // Find or create item for this index
    let itemEl = document.getElementById(`batch-item-${index}`);
    if (!itemEl) {
      if (index === 0) {
        batchStatusLog.innerHTML = ''; // clear initial placeholder message
      }
      itemEl = document.createElement('div');
      itemEl.id = `batch-item-${index}`;
      itemEl.className = 'batch-log-item';
      batchStatusLog.appendChild(itemEl);
    }
    
    let statusClass = 'opening';
    if (statusText.includes('running')) statusClass = 'running';
    if (statusText === 'done') statusClass = 'done';
    if (statusText.includes('failed') || statusText.includes('error')) statusClass = 'failed';
    
    itemEl.innerHTML = `
      <div class="batch-log-url" title="${UTILS.escapeHTML(url)}">[${index + 1}/${total}] ${UTILS.escapeHTML(url)}</div>
      <div class="batch-log-status">
        <span class="batch-log-status-label">Status:</span>
        <span class="batch-log-status-text ${statusClass}">${UTILS.escapeHTML(statusText)}</span>
      </div>
    `;
    
    // Auto-scroll the log container to the bottom
    batchStatusLog.scrollTop = batchStatusLog.scrollHeight;
  }

  startBatchBtn.addEventListener('click', async () => {
    const text = batchUrlsInput.value.trim();
    if (!text) {
      showFooterMessage('Please enter at least one URL.');
      return;
    }
    const urls = text.split('\n')
      .map(u => u.trim())
      .filter(u => u.startsWith('http://') || u.startsWith('https://'));
    
    if (urls.length === 0) {
      showFooterMessage('No valid HTTP/HTTPS URLs found.');
      return;
    }
    
    startBatchBtn.disabled = true;
    showFooterMessage(`Starting batch of ${urls.length} application(s)...`);
    try {
      await startBatchApply(urls);
      showFooterMessage('Batch application sequence completed.');
    } catch (err) {
      showFooterMessage(`Batch error: ${err.message}`);
    } finally {
      startBatchBtn.disabled = false;
    }
  });

  // Initial dashboard scan on launch
  refreshDashboard();
});
