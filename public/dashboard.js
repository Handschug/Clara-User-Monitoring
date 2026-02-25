/**
 * Clara Activation Dashboard — frontend logic
 */

// ── State ─────────────────────────────────────────────────

let pilotOnly = true;
let viewMode = 'grid'; // 'grid' | 'list'
let refreshTimer = null;
let _currentModalOrgId = null; // org ID currently open in modal

// Attio pipeline state
let _deals = [];       // AttioDeal[] from /api/attio/pipeline
let _dealMap = {};     // lowercase deal name → AttioDeal (for name matching)

// ── DOM refs ──────────────────────────────────────────────

const orgGrid      = document.getElementById('org-grid');
const btnGrid      = document.getElementById('btn-grid');
const btnListView  = document.getElementById('btn-list');
const statusDot    = document.getElementById('status-dot');
const statusText   = document.getElementById('status-text');
const lastUpdatedEl = document.getElementById('last-updated');
const errorBanner  = document.getElementById('error-banner');
const summaryEl    = document.getElementById('summary');
const btnAll       = document.getElementById('btn-all');
const btnPilot     = document.getElementById('btn-pilot');
const modalOverlay = document.getElementById('modal-overlay');
const modalBody    = document.getElementById('modal-body');
const modalTitle   = document.getElementById('modal-title');
const modalClose   = document.getElementById('modal-close');

// ── Utilities ─────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function relativeTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

function daysSince(iso) {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Attio pipeline ────────────────────────────────────────

async function loadAttioPipeline() {
  try {
    const data = await fetchJson('/api/attio/pipeline');
    _deals = data.deals ?? [];
    _dealMap = {};
    for (const deal of _deals) {
      _dealMap[deal.name.toLowerCase()] = deal;
    }
  } catch {
    // Attio is optional — silently skip if token not configured
  }
}

/** Find the best-matching Attio deal for a Clara org by name. */
function findDeal(orgName) {
  const norm = orgName.toLowerCase();
  // Exact match first
  if (_dealMap[norm]) return _dealMap[norm];
  // Partial: deal name is a prefix/suffix of org name or vice versa
  for (const [dealName, deal] of Object.entries(_dealMap)) {
    if (norm.includes(dealName) || dealName.includes(norm)) return deal;
  }
  return null;
}

const STAGE_ORDER = [
  'Discovery - Stage 1',
  'Demo - Stage 2',
  'MVP/Pilot - Stage 3',
  'Won - Stage 4',
  'Lost',
];

function stageBadgeClass(stage) {
  if (stage.startsWith('Won'))       return 'stage-won';
  if (stage.startsWith('MVP/Pilot')) return 'stage-pilot';
  if (stage.startsWith('Demo'))      return 'stage-demo';
  if (stage === 'Lost')              return 'stage-lost';
  return 'stage-discovery';
}

function stageShortLabel(stage) {
  if (stage.startsWith('Discovery')) return 'Discovery';
  if (stage.startsWith('Demo'))      return 'Demo';
  if (stage.startsWith('MVP/Pilot')) return 'Pilot';
  if (stage.startsWith('Won'))       return 'Won';
  if (stage === 'Lost')              return 'Lost';
  return stage;
}


// ── Status check ──────────────────────────────────────────

async function checkStatus() {
  try {
    const data = await fetchJson('/api/status');
    statusDot.className = data.connected ? 'connected' : 'disconnected';
    statusText.textContent = data.connected
      ? `Connected · ${data.latencyMs}ms`
      : 'MCP disconnected';
  } catch {
    statusDot.className = 'disconnected';
    statusText.textContent = 'Unreachable';
  }
}

// ── Health labels ─────────────────────────────────────────

function healthLabel(status) {
  if (status === 'green')  return 'Active';
  if (status === 'yellow') return 'No recent activity';
  return 'Needs attention';
}

// ── Last-active pill ──────────────────────────────────────

function lastActivePill(org) {
  const ts = org.lastAgentEvent;
  if (!ts) {
    return `<div class="last-active stale"><span class="dot"></span>Agent never ran</div>`;
  }
  const days = daysSince(ts);
  const label = relativeTime(ts);
  if (days <= 1) {
    return `<div class="last-active recent"><span class="dot"></span>Agent active ${label}</div>`;
  }
  if (days <= 7) {
    return `<div class="last-active"><span class="dot"></span>Agent active ${label}</div>`;
  }
  return `<div class="last-active stale"><span class="dot"></span>Agent last active ${label}</div>`;
}

// ── Activation checklist ──────────────────────────────────

function checklistHtml(org) {
  const steps = [
    { done: org.hasEmailSync,             label: 'Email sync' },
    { done: org.totalEmails > 0,          label: 'Emails synced' },
    { done: org.agentEventsLast7Days > 0, label: 'Agent active' },
    { done: org.draftsCreated > 0,        label: 'Drafts' },
  ];
  return `<div class="checklist">${steps.map(s =>
    `<span class="check-pill ${s.done ? 'done' : ''}">${s.done ? '✓' : '·'} ${s.label}</span>`
  ).join('')}</div>`;
}

// ── Score chip ────────────────────────────────────────────

function scoreChip(score) {
  const cls = score === 4 ? 'score-4' : score === 0 ? 'score-0' : '';
  return `<div class="score-chip ${cls}">${score}/4</div>`;
}

// ── Render card ───────────────────────────────────────────

function renderCard(org) {
  const card = document.createElement('div');
  card.className = `org-card ${org.healthStatus}`;
  card.dataset.orgId = org.orgId;

  const tagsHtml = org.tags.length
    ? `<div class="tags">${org.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>`
    : '';

  const emailActivity = org.emailsLast7Days > 0
    ? `<span class="metric-sub">${org.emailsLast7Days} this week</span>`
    : `<span class="metric-sub danger-sub">0 this week</span>`;

  const syncErrorHtml = org.hasSyncError
    ? `<div class="sync-error-banner">
        <span class="err-icon">⚠</span>
        ${org.syncErrorCount} account${org.syncErrorCount !== 1 ? 's' : ''} failing to sync
      </div>`
    : '';

  const deal = findDeal(org.orgName);
  const attioBadge = deal
    ? `<span class="attio-stage-badge ${stageBadgeClass(deal.stage)}">${stageShortLabel(deal.stage)}</span>`
    : '';
  const meetingBadge = deal?.nextMeeting
    ? (() => {
        const d = new Date(deal.nextMeeting + 'T00:00:00');
        const label = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        return `<span class="meeting-badge">Call ${label}</span>`;
      })()
    : '';

  card.innerHTML = `
    <div class="card-header">
      <div class="card-title-block">
        <h2>${escHtml(org.orgName)}</h2>
        <div class="card-meta">
          <span class="health-indicator ${org.healthStatus}">
            <span class="hdot"></span>${healthLabel(org.healthStatus)}
          </span>
          ${meetingBadge}
        </div>
      </div>
      <div class="card-chips">
        ${attioBadge}
        ${scoreChip(org.activationScore)}
      </div>
    </div>

    ${syncErrorHtml}
    ${tagsHtml}

    ${checklistHtml(org)}

    <div class="metrics">
      <div class="metric">
        <span class="metric-value ${org.totalEmails > 0 ? '' : 'danger'}">${org.totalEmails.toLocaleString('de-DE')}</span>
        <span class="metric-label">Emails total</span>
        ${emailActivity}
      </div>
      <div class="metric">
        <span class="metric-value ${org.agentEventsLast7Days > 0 ? 'positive' : 'danger'}">${org.agentEventsLast7Days}</span>
        <span class="metric-label">Agent events</span>
        <span class="metric-sub">last 7 days</span>
      </div>
      <div class="metric">
        <span class="metric-value ${org.draftsCreated > 0 ? 'purple' : ''}">${org.draftsCreated}</span>
        <span class="metric-label">Drafts</span>
        <span class="metric-sub">created by Clara</span>
      </div>
    </div>

    ${lastActivePill(org)}
  `;

  card.addEventListener('click', () => openOrgDetail(org.orgId, org.orgName));
  return card;
}

// ── Sort orgs (shared) ────────────────────────────────────

function sortOrgs(orgs) {
  const order = { red: 0, yellow: 1, green: 2 };
  return [...orgs].sort((a, b) => {
    if (order[a.healthStatus] !== order[b.healthStatus]) return order[a.healthStatus] - order[b.healthStatus];
    return b.activationScore - a.activationScore;
  });
}

// ── Render grid ───────────────────────────────────────────

function renderGrid(orgs) {
  orgGrid.innerHTML = '';
  orgGrid.style.display = '';
  const existing = document.getElementById('org-list');
  if (existing) existing.remove();
  errorBanner.style.display = 'none';

  if (orgs.length === 0) {
    orgGrid.innerHTML = '<div id="loading">No organizations found.</div>';
    return;
  }

  for (const org of sortOrgs(orgs)) orgGrid.appendChild(renderCard(org));
}

// ── Render list ───────────────────────────────────────────

function renderList(orgs) {
  orgGrid.style.display = 'none';
  const existing = document.getElementById('org-list');
  if (existing) existing.remove();
  errorBanner.style.display = 'none';

  const wrap = document.createElement('div');
  wrap.id = 'org-list';

  if (orgs.length === 0) {
    wrap.innerHTML = '<p style="color:var(--text-muted);padding:32px;text-align:center">No organizations found.</p>';
    document.querySelector('main').appendChild(wrap);
    return;
  }

  const sorted = sortOrgs(orgs);

  wrap.innerHTML = `
    <table class="list-table">
      <thead>
        <tr>
          <th>Organization</th>
          <th>Score</th>
          <th>Email sync</th>
          <th class="right">Emails total</th>
          <th class="right">Emails 7d</th>
          <th class="right">Agent events 7d</th>
          <th class="right">Drafts</th>
          <th>Last active</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(org => {
          const scoreClass = org.activationScore === 4 ? 's4' : org.activationScore === 0 ? 's0' : '';
          const syncPill = org.hasSyncError
            ? `<span class="list-pill danger">⚠ ${org.syncErrorCount} error${org.syncErrorCount !== 1 ? 's' : ''}</span>`
            : org.hasEmailSync
              ? `<span class="list-pill ok">✓ Connected</span>`
              : `<span class="list-pill muted">Not connected</span>`;
          const lastActive = org.lastAgentEvent ? relativeTime(org.lastAgentEvent) : '—';
          const lastActiveStyle = org.lastAgentEvent && daysSince(org.lastAgentEvent) <= 1
            ? 'color:var(--green);font-weight:600'
            : org.lastAgentEvent && daysSince(org.lastAgentEvent) > 7
              ? 'color:var(--red)'
              : '';
          const statusPill = org.healthStatus === 'green'
            ? `<span class="list-pill ok">Active</span>`
            : org.healthStatus === 'yellow'
              ? `<span class="list-pill warn">Partial</span>`
              : `<span class="list-pill danger">Stuck</span>`;
          const agentClass = org.agentEventsLast7Days > 0 ? 'ok' : 'danger';

          return `
            <tr data-org-id="${escHtml(org.orgId)}" data-org-name="${escHtml(org.orgName)}">
              <td>
                <div class="list-name-cell">
                  <div class="list-dot ${org.healthStatus}"></div>
                  <span class="list-org-name">${escHtml(org.orgName)}</span>
                  ${org.hasSyncError ? '<span class="list-err-icon">⚠</span>' : ''}
                </div>
              </td>
              <td><span class="list-score ${scoreClass}">${org.activationScore}/4</span></td>
              <td>${syncPill}</td>
              <td class="right"><span class="list-num">${org.totalEmails.toLocaleString('de-DE')}</span></td>
              <td class="right"><span class="list-num ${org.emailsLast7Days === 0 ? 'danger' : ''}" style="${org.emailsLast7Days === 0 ? 'color:var(--red)' : ''}">${org.emailsLast7Days}</span></td>
              <td class="right"><span class="list-pill ${agentClass}">${org.agentEventsLast7Days}</span></td>
              <td class="right"><span class="list-num">${org.draftsCreated}</span></td>
              <td><span style="${lastActiveStyle}">${lastActive}</span></td>
              <td>${statusPill}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('tbody tr').forEach(row => {
    row.addEventListener('click', () => {
      openOrgDetail(row.dataset.orgId, row.dataset.orgName);
    });
  });

  document.querySelector('main').appendChild(wrap);
}

// ── Unified render ────────────────────────────────────────

function renderOrgs(orgs) {
  const green  = orgs.filter(o => o.healthStatus === 'green').length;
  const yellow = orgs.filter(o => o.healthStatus === 'yellow').length;
  const red    = orgs.filter(o => o.healthStatus === 'red').length;
  summaryEl.innerHTML = `
    <strong>${orgs.length}</strong> orgs &nbsp;·&nbsp;
    <span style="color:var(--green)">${green} active</span> &nbsp;·&nbsp;
    <span style="color:var(--purple)">${yellow} partial</span> &nbsp;·&nbsp;
    <span style="color:var(--red)">${red} stuck</span>
  `;

  if (viewMode === 'list') renderList(orgs);
  else renderGrid(orgs);
}

// ── Fetch & load ──────────────────────────────────────────

async function loadActivation() {
  orgGrid.style.display = '';
  orgGrid.innerHTML = '<div id="loading"><div class="spinner"></div>Loading…</div>';
  const existing = document.getElementById('org-list');
  if (existing) existing.remove();

  try {
    const data = await fetchJson(`/api/activation?pilotOnly=${pilotOnly}`);
    lastUpdatedEl.textContent = `Updated ${formatDate(data.updatedAt)}`;
    _lastOrgs = data.activation;
    renderOrgs(_lastOrgs);
  } catch (err) {
    orgGrid.innerHTML = '';
    errorBanner.style.display = 'block';
    errorBanner.textContent = `Failed to load data: ${err.message}`;
    console.error('[dashboard]', err);
  }
}

// ── Detail modal ──────────────────────────────────────────

async function openOrgDetail(orgId, orgName) {
  _currentModalOrgId = orgId;
  modalTitle.textContent = orgName;
  modalBody.innerHTML = '<div class="spinner" style="margin:32px auto"></div>';
  modalOverlay.classList.add('open');

  try {
    const detail = await fetchJson(`/api/org/${orgId}`);
    renderModalBody(detail);
  } catch (err) {
    modalBody.innerHTML = `<p style="color:var(--red);font-size:13px">Error: ${err.message}</p>`;
  }
}


function renderModalBody(detail) {
  // ── Email accounts ──────────────────────────────────────
  const accountsHtml = detail.emailAccounts.length
    ? detail.emailAccounts.map(a => `
        <div class="account-row">
          <span class="account-email">${escHtml(a.email)}</span>
          <span class="account-provider">${escHtml(a.provider)}</span>
          ${a.hasSyncError
            ? `<span class="account-status error" title="${escHtml(a.syncError ?? '')}">⚠ Sync error</span>`
            : `<span class="account-status ok">✓ Syncing</span>`}
        </div>`).join('')
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No email accounts connected.</p>';

  // ── Agent event breakdown ───────────────────────────────
  const maxCount = Math.max(...detail.eventBreakdown.map(b => b.count), 1);
  const eventLabels = {
    email_classified: 'Email classified',
    tags_applied:     'Tags applied',
    email_moved:      'Email moved',
    draft_created:    'Draft created',
  };

  const breakdownHtml = detail.eventBreakdown.length
    ? `<div class="breakdown-grid">
        ${detail.eventBreakdown.map(b => {
          const pct = Math.round((b.count / maxCount) * 100);
          const label = eventLabels[b.eventType] ?? b.eventType;
          return `
            <div class="breakdown-row">
              <div class="breakdown-label-row">
                <span class="breakdown-type">${escHtml(label)}</span>
                <span class="breakdown-counts">
                  <strong>${b.count.toLocaleString('de-DE')}</strong> total
                  &nbsp;·&nbsp; ${b.countLast7Days} last 7d
                </span>
              </div>
              <div class="breakdown-bar-track">
                <div class="breakdown-bar-fill" style="width:${pct}%"></div>
              </div>
            </div>`;
        }).join('')}
      </div>`
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No agent activity yet.</p>';

  // ── Members ─────────────────────────────────────────────
  const membersHtml = detail.members.length
    ? `<table>
        <thead><tr><th>Email</th><th>Role</th></tr></thead>
        <tbody>
          ${detail.members.map(m => `
            <tr>
              <td>${escHtml(m.email)}</td>
              <td>${escHtml(m.role)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`
    : '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">No members found.</p>';

  // ── Attio deal section ──────────────────────────────────
  const deal = findDeal(detail.orgName);
  const attioSectionHtml = deal ? `
    <div class="attio-section">
      <div class="attio-row">
        <span class="attio-icon">A</span>
        <div class="attio-deal-info">
          <span class="attio-stage-badge ${stageBadgeClass(deal.stage)}">${stageShortLabel(deal.stage)}</span>
          ${deal.nextMeeting ? `<span class="attio-next-meeting">Next call: <strong>${formatDate(deal.nextMeeting + 'T00:00:00')}</strong></span>` : ''}
        </div>
      </div>
    </div>
  ` : '';

  modalBody.innerHTML = `
    ${attioSectionHtml}
    <div class="section-title">Email Search</div>
    <div class="email-search-bar">
      <input
        type="text"
        id="email-search-input"
        class="email-search-input"
        placeholder="Search emails processed by Clara…"
        autocomplete="off"
      >
      <button id="email-search-btn" class="email-search-btn">Search</button>
    </div>
    <div id="email-search-results" class="email-search-results">
      <p class="email-search-hint">Type a keyword to search emails — e.g. "Einkommensteuer", "Termin", "Rückfrage"</p>
    </div>

    <div class="section-title" style="margin-top:24px">Connected Email Accounts</div>
    ${accountsHtml}

    <div class="section-title" style="margin-top:20px">Agent Activity Breakdown</div>
    ${breakdownHtml}

    <div class="section-title" style="margin-top:20px">Members (${detail.memberCount})</div>
    ${membersHtml}
  `;

  // Wire up email search
  const searchInput = document.getElementById('email-search-input');
  const searchBtn   = document.getElementById('email-search-btn');
  const resultsEl   = document.getElementById('email-search-results');

  async function runEmailSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    resultsEl.innerHTML = '<div class="spinner" style="margin:16px auto"></div>';
    try {
      const data = await fetchJson(`/api/org/${_currentModalOrgId}/emails?q=${encodeURIComponent(q)}`);
      renderEmailResults(resultsEl, data.emails, q);
    } catch (err) {
      resultsEl.innerHTML = `<p style="color:var(--red);font-size:13px;padding:8px 0">Search error: ${escHtml(err.message)}</p>`;
    }
  }

  searchBtn.addEventListener('click', runEmailSearch);
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runEmailSearch(); });

}

function renderEmailResults(container, emails, query) {
  if (!emails.length) {
    container.innerHTML = `<p class="email-search-hint">No emails found for "<strong>${escHtml(query)}</strong>"</p>`;
    return;
  }
  container.innerHTML = `
    <div class="email-result-count">${emails.length} result${emails.length !== 1 ? 's' : ''} for "<strong>${escHtml(query)}</strong>"</div>
    ${emails.map(e => `
      <div class="email-result-row">
        <div class="email-result-header">
          <span class="email-result-subject">${escHtml(e.subject)}</span>
          <span class="email-result-date">${e.receivedAt ? formatDate(e.receivedAt) : '—'}</span>
        </div>
        ${e.from ? `<div class="email-result-from">${escHtml(e.from)}</div>` : ''}
        ${e.snippet ? `<div class="email-result-snippet">${escHtml(e.snippet)}</div>` : ''}
      </div>`).join('')}
  `;
}

function closeModal() { modalOverlay.classList.remove('open'); }

// ── View toggle ───────────────────────────────────────────

let _lastOrgs = [];

btnGrid.addEventListener('click', () => {
  if (viewMode === 'grid') return;
  viewMode = 'grid';
  btnGrid.classList.add('active');
  btnListView.classList.remove('active');
  renderOrgs(_lastOrgs);
});

btnListView.addEventListener('click', () => {
  if (viewMode === 'list') return;
  viewMode = 'list';
  btnListView.classList.add('active');
  btnGrid.classList.remove('active');
  renderOrgs(_lastOrgs);
});

// ── Filter controls ───────────────────────────────────────

btnPilot.addEventListener('click', () => {
  if (pilotOnly) return;
  pilotOnly = true;
  btnPilot.classList.add('active');
  btnAll.classList.remove('active');
  loadActivation();
});

btnAll.addEventListener('click', () => {
  if (!pilotOnly) return;
  pilotOnly = false;
  btnAll.classList.add('active');
  btnPilot.classList.remove('active');
  loadActivation();
});

modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

// ── Auto-refresh every 60s ────────────────────────────────

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    loadActivation();
    checkStatus();
  }, 60_000);
}

// ── Init ──────────────────────────────────────────────────

checkStatus();
loadActivation();
loadAttioPipeline();
startAutoRefresh();
