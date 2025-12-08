/**
 * SuperGO App - Production Grade
 * All edge cases handled.
 */

// Init Engine (150 MB/s limit)
const supergo = new SuperGO({ maxSpeed: 150 * 1024 * 1024 });
const $ = id => document.getElementById(id);

// DOM Cache
const el = {
    status: $('status'),
    deviceCount: $('device-count'),
    deviceGrid: $('device-grid'),
    transferPanel: $('transfer-panel'),
    backBtn: $('back-btn'),
    targetName: $('target-name'),
    dropZone: $('drop-zone'),
    fileInput: $('file-input'),
    transferList: $('transfer-list'),
    emptyHistory: $('empty-history'),
    incomingModal: $('incoming-modal'),
    incomingSender: $('incoming-sender'),
    incomingFilename: $('incoming-filename'),
    acceptBtn: $('accept-btn'),
    rejectBtn: $('reject-btn')
};

// State
let selectedDeviceId = null;
let hasConnectedOnce = false;
const transferHistory = new Map(); // deviceId -> Array<Transfer>
const toastHistory = new Map();

// ─────────────────────────────────────────────────────────────
// UI HELPERS
// ─────────────────────────────────────────────────────────────

const ui = {
    setStatus(state, text) {
        const dot = el.status.querySelector('.dot');
        const label = el.status.querySelector('.text');
        dot.className = 'dot ' + (state === 'online' ? 'green' : 'red');
        label.textContent = text;
    },

    openPanel(device) {
        selectedDeviceId = device.id;
        el.targetName.textContent = device.name;
        el.targetName.style.opacity = '1';
        el.transferPanel.classList.remove('empty');
        el.transferPanel.classList.add('active');

        const content = el.transferPanel.querySelector('.panel-content');
        if (content) content.classList.remove('hidden');

        renderTransferList(device.id);
        updateDropZoneState();

        document.querySelectorAll('.device-card').forEach(c =>
            c.classList.toggle('active', c.dataset.id === device.id));
    },

    closePanel() {
        selectedDeviceId = null;
        el.transferPanel.classList.remove('active');
        el.transferPanel.classList.add('empty');

        const content = el.transferPanel.querySelector('.panel-content');
        if (content) content.classList.add('hidden');

        document.querySelectorAll('.device-card').forEach(c => c.classList.remove('active'));
    },

    formatBytes(bytes) {
        if (!bytes) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
    },

    showToast(msg, type = 'info') {
        const now = Date.now();
        if (toastHistory.has(msg) && now - toastHistory.get(msg) < 2000) return;
        toastHistory.set(msg, now);

        const t = document.createElement('div');
        t.className = `toast ${type}`;
        t.innerHTML = `<span>${msg}</span>`;
        $('toast-container').appendChild(t);

        setTimeout(() => {
            t.classList.add('hiding');
            setTimeout(() => t.remove(), 200);
        }, 3000);
    }
};

// Update drop zone based on busy state
function updateDropZoneState() {
    const busy = supergo.isBusy;
    el.dropZone.style.opacity = busy ? '0.5' : '1';
    el.dropZone.style.pointerEvents = busy ? 'none' : 'auto';
}

// ─────────────────────────────────────────────────────────────
// CORE LOGIC
// ─────────────────────────────────────────────────────────────

// Device Detection
const ua = navigator.userAgent;
const deviceName =
    /iPhone/.test(ua) ? 'iPhone' :
        /iPad/.test(ua) ? 'iPad' :
            /Android/.test(ua) ? 'Android' :
                /Mac/.test(ua) ? 'Mac' :
                    /Windows/.test(ua) ? 'Windows PC' : 'Desktop';
const deviceType = /Mobile|Android|iPhone/.test(ua) ? 'phone' : 'desktop';

supergo.connect({ name: deviceName, type: deviceType });

// ─────────────────────────────────────────────────────────────
// CONNECTION EVENTS
// ─────────────────────────────────────────────────────────────

supergo.on('connected', (device) => {
    hasConnectedOnce = true;
    ui.setStatus('online', 'Online');
    document.querySelector('.header .logo').innerHTML =
        `SuperGO <span style="font-size:12px;color:var(--md-sys-color-outline);margin-left:8px;font-weight:400">${device.name}</span>`;
});

supergo.on('disconnected', () => {
    ui.setStatus('offline', 'Disconnected');
    if (hasConnectedOnce) ui.showToast('Connection lost. Reconnecting...', 'error');

    // EDGE CASE: Close modal if open (sender might have disconnected)
    el.incomingModal.classList.remove('visible');

    // Reset UI state
    updateDropZoneState();
});

// ─────────────────────────────────────────────────────────────
// DEVICE LIST
// ─────────────────────────────────────────────────────────────

supergo.on('devicesUpdated', (devices) => {
    el.deviceCount.textContent = devices.length ? `${devices.length}` : '';

    if (!devices.length) {
        if (!el.deviceGrid.querySelector('.empty-state')) {
            el.deviceGrid.innerHTML = `<div class="empty-state"><i class="ph ph-broadcast"></i><p>Scanning for devices...</p></div>`;
        }
        return;
    }

    if (el.deviceGrid.querySelector('.empty-state')) el.deviceGrid.innerHTML = '';

    const currentMap = new Map();
    el.deviceGrid.querySelectorAll('.device-card').forEach(c => currentMap.set(c.dataset.id, c));

    // Update/Create cards
    devices.forEach(d => {
        let card = currentMap.get(d.id);
        const icon = d.type === 'phone' ? 'device-mobile' : 'desktop';

        if (card) {
            const nameEl = card.querySelector('.device-name');
            if (nameEl.textContent !== d.name) nameEl.textContent = d.name;
            card.classList.toggle('active', selectedDeviceId === d.id);
            currentMap.delete(d.id);
        } else {
            card = document.createElement('div');
            card.className = 'device-card';
            card.dataset.id = d.id;
            card.onclick = () => ui.openPanel(d);
            card.innerHTML = `
                <div class="device-icon"><i class="ph ph-${icon}"></i></div>
                <div class="device-info">
                    <div class="device-name">${d.name}</div>
                    <div class="device-status">Tap to send</div>
                </div>
            `;
            el.deviceGrid.appendChild(card);
        }
    });

    // Remove stale cards
    currentMap.forEach(c => c.remove());

    // Update active panel state
    if (selectedDeviceId) {
        const active = devices.find(d => d.id === selectedDeviceId);
        if (active) {
            el.targetName.style.opacity = '1';
            updateDropZoneState();
        } else {
            // EDGE CASE: Selected device disconnected
            el.targetName.textContent = 'Device Disconnected';
            el.targetName.style.opacity = '0.5';
            el.dropZone.style.pointerEvents = 'none';
            el.dropZone.style.opacity = '0.5';
        }
    }
});

// ─────────────────────────────────────────────────────────────
// TRANSFER HISTORY
// ─────────────────────────────────────────────────────────────

function addTransferRecord(deviceId, data) {
    if (!transferHistory.has(deviceId)) transferHistory.set(deviceId, []);
    const list = transferHistory.get(deviceId);

    if (list.length > 50) list.pop(); // Memory cap
    list.unshift(data);

    if (selectedDeviceId === deviceId) renderTransferList(deviceId);
}

function updateActiveTransfer(deviceId, updates) {
    const list = transferHistory.get(deviceId);
    if (!list) return;

    const t = list.find(x => x.status === 'sending' || x.status === 'receiving');
    if (!t) return;

    Object.assign(t, updates);

    // Surgical DOM Update
    if (selectedDeviceId === deviceId) {
        const row = document.getElementById(`tx-${t.id}`);
        if (row) {
            const meta = row.querySelector('.transfer-meta');
            if (updates.status === 'completed') {
                meta.innerHTML = `<span style="color:var(--md-sys-color-success)">✓ Completed</span>`;
                const bar = row.querySelector('.transfer-progress-bar');
                if (bar) bar.remove();
            } else if (updates.status === 'error') {
                meta.innerHTML = `<span style="color:var(--md-sys-color-error)">✕ Failed</span>`;
                const bar = row.querySelector('.transfer-progress-bar');
                if (bar) bar.remove();
            } else if (updates.percent !== undefined) {
                meta.textContent = `${updates.percent}% · ${ui.formatBytes(updates.speed)}/s`;
                const bar = row.querySelector('.transfer-progress-fill');
                if (bar) bar.style.width = `${updates.percent}%`;
            }
        } else {
            renderTransferList(deviceId);
        }
    }
}

function renderTransferList(deviceId) {
    const list = transferHistory.get(deviceId) || [];
    if (!list.length) {
        el.transferList.innerHTML = '';
        el.transferList.appendChild(el.emptyHistory);
        el.emptyHistory.style.display = 'block';
        return;
    }

    el.emptyHistory.style.display = 'none';
    el.transferList.innerHTML = list.map(t => {
        const isOut = t.direction === 'outgoing';
        const icon = isOut ? 'arrow-up' : 'arrow-down';
        const cls = isOut ? 'sending' : 'receiving';

        let metaHtml = '';
        if (t.status === 'completed') metaHtml = '<span style="color:var(--md-sys-color-success)">✓ Completed</span>';
        else if (t.status === 'error') metaHtml = '<span style="color:var(--md-sys-color-error)">✕ Failed</span>';
        else metaHtml = `${t.percent || 0}% · 0 B/s`;

        const showBar = t.status === 'sending' || t.status === 'receiving';

        return `
        <div class="transfer-item" id="tx-${t.id}">
            <div class="transfer-icon ${cls}"><i class="ph ph-${icon}"></i></div>
            <div class="transfer-details">
                <div class="transfer-name">${t.fileName}</div>
                <div class="transfer-meta">${metaHtml}</div>
                ${showBar ? `<div class="transfer-progress-bar"><div class="transfer-progress-fill" style="width:${t.percent || 0}%"></div></div>` : ''}
            </div>
        </div>`;
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// SENDING
// ─────────────────────────────────────────────────────────────

const startSend = (file) => {
    // EDGE CASE: No target selected
    if (!selectedDeviceId) {
        ui.showToast('Select a device first', 'error');
        return;
    }
    // EDGE CASE: Empty file
    if (!file || !file.size) {
        ui.showToast('Cannot send empty file', 'error');
        return;
    }
    // EDGE CASE: Already busy
    if (supergo.isBusy) {
        ui.showToast('Transfer in progress', 'error');
        return;
    }

    supergo.sendFile(selectedDeviceId, file);
    updateDropZoneState();
};

el.dropZone.onclick = () => {
    if (!supergo.isBusy) el.fileInput.click();
};
el.fileInput.onchange = () => {
    if (el.fileInput.files[0]) startSend(el.fileInput.files[0]);
    el.fileInput.value = '';
};

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
    el.dropZone.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); });
});
el.dropZone.addEventListener('drop', e => {
    if (!supergo.isBusy && e.dataTransfer.files[0]) startSend(e.dataTransfer.files[0]);
});

supergo.on('transferPending', ({ targetId }) => {
    // Waiting for acceptance...
    updateDropZoneState();
});

supergo.on('transferStarted', ({ targetId, fileName, total }) => {
    addTransferRecord(targetId, {
        id: Date.now(), fileName, size: total,
        direction: 'outgoing', status: 'sending', percent: 0
    });
    updateDropZoneState();
});

supergo.on('transferProgress', d => {
    updateActiveTransfer(d.targetId, { percent: d.percent, speed: d.speed });
});

supergo.on('transferComplete', ({ targetId, fileName }) => {
    updateActiveTransfer(targetId, { status: 'completed', percent: 100 });
    updateDropZoneState();
    ui.showToast(`${fileName} sent`, 'success');
});

supergo.on('transferError', ({ targetId, senderId, error }) => {
    const deviceId = targetId || senderId;
    if (deviceId) {
        updateActiveTransfer(deviceId, { status: 'error' });
    }
    updateDropZoneState();
    ui.showToast(error || 'Transfer failed', 'error');
});

supergo.on('transferRejected', ({ reason }) => {
    updateDropZoneState();
    ui.showToast(reason || 'Transfer rejected', 'error');
});

// ─────────────────────────────────────────────────────────────
// RECEIVING
// ─────────────────────────────────────────────────────────────

supergo.on('incomingFile', (data) => {
    el.incomingSender.textContent = `from ${data.senderName || 'Unknown'}`;
    el.incomingFilename.textContent = `${data.fileName} (${ui.formatBytes(data.fileSize)})`;
    el.incomingModal.classList.add('visible');
});

// EDGE CASE: Sender disconnected while modal is open
supergo.on('incomingFileCancelled', () => {
    el.incomingModal.classList.remove('visible');
    ui.showToast('Sender disconnected', 'error');
});

el.acceptBtn.onclick = () => {
    const data = supergo.incomingRequest;
    if (!data) return;

    supergo.acceptFile(data.senderId, { fileName: data.fileName, fileSize: data.fileSize });
    el.incomingModal.classList.remove('visible');

    addTransferRecord(data.senderId, {
        id: Date.now(), fileName: data.fileName, size: data.fileSize,
        direction: 'incoming', status: 'receiving', percent: 0
    });

    // Auto-switch to sender's panel
    if (selectedDeviceId !== data.senderId) {
        const d = supergo.devices.find(x => x.id === data.senderId);
        if (d) ui.openPanel(d);
    }

    updateDropZoneState();
};

el.rejectBtn.onclick = () => {
    const data = supergo.incomingRequest;
    if (data) supergo.rejectFile(data.senderId);
    el.incomingModal.classList.remove('visible');
};

supergo.on('receiveProgress', d => {
    updateActiveTransfer(d.senderId, { percent: d.percent, speed: d.speed });
});

supergo.on('fileReceived', ({ senderId, url, fileName }) => {
    updateActiveTransfer(senderId, { status: 'completed', percent: 100 });
    updateDropZoneState();

    // Download
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);

    ui.showToast(`${fileName} received`, 'success');
});

el.backBtn.onclick = ui.closePanel;
