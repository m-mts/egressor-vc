// @ts-check

/** @type {typeof acquireVsCodeApi} */
const vscode = acquireVsCodeApi();

/** @typedef {{ type: 'traffic', timestamp: string, method?: string, host: string, path?: string, port?: number, status: string, category: string, protocol?: string, durationMs?: number, containerId?: string, containerName?: string }} TrafficEntry */
/** @typedef {{ type: 'secret', timestamp: string, secretName: string, secretType: string, target: string, success: boolean, containerId?: string, containerName?: string }} SecretEntry */
/** @typedef {TrafficEntry | SecretEntry} PanelEntry */
/** @typedef {{ id: string, name: string, image: string, protection: string }} ContainerInfo */

const CONTAINER_COLORS = 6;

const state = {
    /** @type {PanelEntry[]} */
    events: [],
    /** @type {ContainerInfo[]} */
    containers: [],
    /** @type {Map<string, number>} */
    containerColorMap: new Map(),
    filter: {
        search: '',
        status: 'all',
        method: 'all',
        container: 'all',
    },
    maxEvents: 500,
};

/**
 * Get a stable color index for a container name.
 * @param {string} name
 * @returns {number}
 */
function getContainerColorIndex(name) {
    if (state.containerColorMap.has(name)) {
        return /** @type {number} */ (state.containerColorMap.get(name));
    }
    const idx = state.containerColorMap.size % CONTAINER_COLORS;
    state.containerColorMap.set(name, idx);
    return idx;
}

function init() {
    const searchInput = document.getElementById('search-input');
    const statusFilter = document.getElementById('status-filter');
    const methodFilter = document.getElementById('method-filter');
    const containerFilter = document.getElementById('container-filter');
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

    if (containerFilter) {
        containerFilter.addEventListener('change', (e) => {
            state.filter.container = /** @type {HTMLSelectElement} */ (e.target).value;
            render();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            state.events = [];
            vscode.setState({ events: state.events, containers: state.containers });
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
            case 'containerStatus':
                updateContainers(message.data);
                break;
            case 'clear':
                state.events = [];
                vscode.setState({ events: state.events, containers: state.containers });
                render();
                break;
        }
    });

    // Restore persisted state
    const persisted = vscode.getState();
    if (persisted && persisted.events) {
        state.events = persisted.events;
    }
    if (persisted && persisted.containers) {
        state.containers = persisted.containers;
    }

    render();
}

/** @param {PanelEntry} entry */
function addEvent(entry) {
    state.events.push(entry);
    if (state.events.length > state.maxEvents) {
        state.events = state.events.slice(-state.maxEvents);
    }
    vscode.setState({ events: state.events, containers: state.containers });
    render();
}

/** @param {ContainerInfo[]} containers */
function updateContainers(containers) {
    state.containers = containers;
    vscode.setState({ events: state.events, containers: state.containers });
    renderContainers();
    updateContainerFilter();
    render();
}

function renderContainers() {
    const section = document.getElementById('containers-section');
    const list = document.getElementById('containers-list');
    if (!section || !list) return;

    if (state.containers.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    list.innerHTML = state.containers.map((c) => {
        const colorIdx = getContainerColorIndex(c.name);
        const protClass = 'prot-' + c.protection;
        const icon = getProtectionIcon(c.protection);
        return `<div class="container-card">
            <span class="container-icon">${icon}</span>
            <span class="container-name container-color-${colorIdx}">${escapeHtml(c.name)}</span>
            <span class="container-image">${escapeHtml(c.image)}</span>
            <span class="container-protection ${protClass}">${escapeHtml(c.protection)}</span>
        </div>`;
    }).join('');
}

/**
 * @param {string} protection
 * @returns {string}
 */
function getProtectionIcon(protection) {
    switch (protection) {
        case 'egress': return '\u{1F6E1}';
        case 'secrets': return '\u{1F512}';
        case 'both': return '\u{1F510}';
        default: return '\u25CB';
    }
}

function updateContainerFilter() {
    const containerFilter = document.getElementById('container-filter');
    if (!containerFilter) return;

    const current = state.filter.container;
    containerFilter.innerHTML = '<option value="all">All Containers</option>';
    for (const c of state.containers) {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        containerFilter.appendChild(opt);
    }
    // Restore selection if still valid
    /** @type {HTMLSelectElement} */ (containerFilter).value =
        state.containers.some(c => c.name === current) ? current : 'all';
    state.filter.container = /** @type {HTMLSelectElement} */ (containerFilter).value;
}

/** @param {PanelEntry} entry */
function matchesFilter(entry) {
    const { search, status, method, container } = state.filter;

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

    if (container !== 'all') {
        const entryContainer = entry.containerName || '';
        if (entryContainer !== container) return false;
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
    const containerBadge = renderContainerBadge(entry);

    if (entry.type === 'secret') {
        return `<div class="event-row ${rowClass}">
            <span class="event-status ${statusClass}">${statusIcon}</span>
            ${containerBadge}
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
        ${containerBadge}
        <span class="event-method">${escapeHtml(method)}</span>
        <span class="event-host">${escapeHtml(host)}${entry.port ? ':' + escapeHtml(String(entry.port)) : ''}</span>
        <span class="event-path">${escapeHtml(path)}</span>
        <span class="event-timing">${timing}</span>
    </div>`;
}

/**
 * Render a container name badge for an event row.
 * @param {PanelEntry} entry
 * @returns {string}
 */
function renderContainerBadge(entry) {
    const name = entry.containerName;
    if (!name) return '';
    const colorIdx = getContainerColorIndex(name);
    return `<span class="event-container container-color-${colorIdx}" title="${escapeHtml(name)}">${escapeHtml(name)}</span>`;
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
