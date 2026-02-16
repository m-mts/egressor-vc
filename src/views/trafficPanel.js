// @ts-check

/** @type {typeof acquireVsCodeApi} */
// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();

/** @typedef {{ type: 'traffic', timestamp: string, method?: string, host: string, path?: string, port?: number, status: string, category: string, protocol?: string, durationMs?: number }} TrafficEntry */
/** @typedef {{ type: 'secret', timestamp: string, secretName: string, secretType: string, target: string, success: boolean }} SecretEntry */
/** @typedef {TrafficEntry | SecretEntry} PanelEntry */

const state = {
    /** @type {PanelEntry[]} */
    events: [],
    filter: {
        search: '',
        status: 'all',
        method: 'all',
    },
    maxEvents: 500,
};

function init() {
    const searchInput = document.getElementById('search-input');
    const statusFilter = document.getElementById('status-filter');
    const methodFilter = document.getElementById('method-filter');
    const clearBtn = document.getElementById('clear-btn');

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.filter.search = /** @type {HTMLInputElement} */ (e.target).value.toLowerCase();
            render();
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', (e) => {
            state.filter.status = /** @type {HTMLSelectElement} */ (e.target).value;
            render();
        });
    }

    if (methodFilter) {
        methodFilter.addEventListener('change', (e) => {
            state.filter.method = /** @type {HTMLSelectElement} */ (e.target).value;
            render();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            state.events = [];
            vscode.setState({ events: state.events });
            render();
        });
    }

    window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.command) {
            case 'trafficEvent':
                addEvent({ type: 'traffic', ...message.data });
                break;
            case 'secretEvent':
                addEvent({ type: 'secret', ...message.data });
                break;
            case 'clear':
                state.events = [];
                vscode.setState({ events: state.events });
                render();
                break;
        }
    });

    // Restore persisted state
    const persisted = vscode.getState();
    if (persisted && persisted.events) {
        state.events = persisted.events;
    }

    render();
}

/** @param {PanelEntry} entry */
function addEvent(entry) {
    state.events.push(entry);
    if (state.events.length > state.maxEvents) {
        state.events = state.events.slice(-state.maxEvents);
    }
    vscode.setState({ events: state.events });
    render();
}

/** @param {PanelEntry} entry */
function matchesFilter(entry) {
    const { search, status, method } = state.filter;

    if (search) {
        const searchable = entry.type === 'traffic'
            ? `${entry.method || ''} ${entry.host} ${entry.path || ''}`
            : `${entry.secretName} ${entry.target}`;
        if (!searchable.toLowerCase().includes(search)) return false;
    }

    if (status !== 'all') {
        if (entry.type === 'traffic') {
            if (status === 'allowed' && entry.status !== 'allowed') return false;
            if (status === 'blocked' && entry.status !== 'blocked') return false;
            if (status === 'secret' && entry.type !== 'secret') return false;
            if (status === 'non-http' && entry.category !== 'non-http') return false;
        } else {
            if (status !== 'secret') return false;
        }
    }

    if (method !== 'all' && entry.type === 'traffic') {
        if (!entry.method || entry.method.toUpperCase() !== method.toUpperCase()) return false;
    }

    return true;
}

/** @param {PanelEntry} entry */
function getRowClass(entry) {
    if (entry.type === 'secret') return 'secret-injected';
    if (entry.category === 'non-http') return 'non-http';
    if (entry.status === 'allowed') return 'allowed';
    if (entry.status === 'blocked') return 'blocked';
    return 'unknown';
}

/** @param {PanelEntry} entry */
function getStatusIcon(entry) {
    if (entry.type === 'secret') return '\u{1F512}';
    if (entry.category === 'non-http') return '\u25CB';
    return entry.status === 'allowed' ? '\u2713' : '\u2717';
}

/** @param {PanelEntry} entry */
function getStatusClass(entry) {
    if (entry.type === 'secret') return 'secret-injected';
    if (entry.category === 'non-http') return 'non-http';
    if (entry.status === 'allowed') return 'allowed';
    if (entry.status === 'blocked') return 'blocked';
    return 'unknown';
}

/** @param {PanelEntry} entry */
function renderRow(entry) {
    const rowClass = getRowClass(entry);
    const statusIcon = getStatusIcon(entry);
    const statusClass = getStatusClass(entry);

    if (entry.type === 'secret') {
        return `<div class="event-row ${rowClass}">
            <span class="event-status ${statusClass}">${statusIcon}</span>
            <span class="event-method">INJECT</span>
            <span class="event-host">${escapeHtml(entry.target)}</span>
            <span class="event-path">${escapeHtml(entry.secretName)} (${escapeHtml(entry.secretType)})</span>
            <span class="event-timing">${entry.success ? 'OK' : 'FAIL'}</span>
        </div>`;
    }

    const method = entry.method || entry.protocol || '-';
    const host = entry.host || '-';
    const path = entry.path || '';
    const timing = entry.durationMs ? `${entry.durationMs}ms` : '';

    return `<div class="event-row ${rowClass}">
        <span class="event-status ${statusClass}">${statusIcon}</span>
        <span class="event-method">${escapeHtml(method)}</span>
        <span class="event-host">${escapeHtml(host)}${entry.port ? ':' + escapeHtml(String(entry.port)) : ''}</span>
        <span class="event-path">${escapeHtml(path)}</span>
        <span class="event-timing">${timing}</span>
    </div>`;
}

function render() {
    const eventList = document.getElementById('event-list');
    const emptyState = document.getElementById('empty-state');
    const summaryBar = document.getElementById('summary-bar');

    if (!eventList || !emptyState || !summaryBar) return;

    const filtered = state.events.filter(matchesFilter);

    // Update summary
    const counts = { allowed: 0, blocked: 0, secret: 0, nonhttp: 0 };
    for (const e of state.events) {
        if (e.type === 'secret') { counts.secret++; }
        else if (e.category === 'non-http') { counts.nonhttp++; }
        else if (e.status === 'allowed') { counts.allowed++; }
        else if (e.status === 'blocked') { counts.blocked++; }
    }

    const countAllowed = document.getElementById('count-allowed');
    const countBlocked = document.getElementById('count-blocked');
    const countSecret = document.getElementById('count-secret');
    const countNonhttp = document.getElementById('count-nonhttp');
    if (countAllowed) countAllowed.textContent = String(counts.allowed);
    if (countBlocked) countBlocked.textContent = String(counts.blocked);
    if (countSecret) countSecret.textContent = String(counts.secret);
    if (countNonhttp) countNonhttp.textContent = String(counts.nonhttp);

    if (filtered.length === 0) {
        eventList.classList.add('hidden');
        emptyState.classList.remove('hidden');
    } else {
        eventList.classList.remove('hidden');
        emptyState.classList.add('hidden');
        eventList.innerHTML = filtered.map(renderRow).join('');
    }
}

/** @param {string} text */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

init();
