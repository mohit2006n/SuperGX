/**
 * SuperGO UI Application
 * Minimal UI layer for the SuperGO P2P engine
 */

const engine = new SuperGO();

// DOM Elements
const $ = id => document.getElementById(id);
const elements = {
    // Views
    landingView: $('landing-view'),
    roomView: $('room-view'),

    // Landing
    nameInput: $('name-input'),
    createBtn: $('create-btn'),
    codeInput: $('code-input'),
    joinBtn: $('join-btn'),
    roomList: $('room-list'),

    // Room
    roomCode: $('room-code'),
    copyBtn: $('copy-btn'),
    peerCount: $('peer-count'),
    participantList: $('participant-list'),
    leaveBtn: $('leave-btn'),
    connectionStatus: $('connection-status'),
    dropZone: $('drop-zone'),
    browseBtn: $('browse-btn'),
    fileInput: $('file-input'),
    fileSection: $('file-section'),
    fileList: $('file-list'),
    downloadBtn: $('download-btn'),
    stopSharingBtn: $('stop-sharing-btn'),
    statusMessage: $('status-message')
};

// ─────────────────────────────────────────────────────────────
// LANDING SCREEN
// ─────────────────────────────────────────────────────────────

function validateLanding() {
    const name = elements.nameInput.value.trim();
    const code = elements.codeInput.value.trim();
    elements.createBtn.disabled = name.length === 0;
    elements.joinBtn.disabled = name.length === 0 || code.length < 4;
}

elements.nameInput.oninput = validateLanding;
elements.codeInput.oninput = (e) => {
    e.target.value = e.target.value.toUpperCase();
    validateLanding();
};

elements.createBtn.onclick = () => {
    const name = elements.nameInput.value.trim();
    const accessRadio = document.querySelector('input[name="access"]:checked');
    const access = accessRadio ? accessRadio.value : 'public';
    const roomId = engine.createRoom(name, { access });
    enterRoom(roomId);
};

elements.joinBtn.onclick = () => {
    const name = elements.nameInput.value.trim();
    const code = elements.codeInput.value.trim();
    engine.joinRoom(code, name);
    enterRoom(code);
};

// Room Discovery
engine.on('roomsUpdated', (sessions) => {
    if (sessions.length === 0) {
        elements.roomList.innerHTML = '<div class="empty-state small">No public rooms available</div>';
        return;
    }

    elements.roomList.innerHTML = sessions.map(s => {
        if (s.isSecure) {
            return `
                <div class="room-item private">
                    <i class="ph ph-lock"></i>
                    <span class="host">${s.hostName}</span>
                    <span class="label">Private</span>
                </div>`;
        }
        return `
            <div class="room-item" data-id="${s.id}">
                <i class="ph ph-globe"></i>
                <span class="host">${s.hostName}</span>
                <span class="code">${s.id}</span>
                <i class="ph ph-arrow-right join-arrow"></i>
            </div>`;
    }).join('');

    // Click handlers for public rooms
    elements.roomList.querySelectorAll('.room-item[data-id]').forEach(item => {
        item.onclick = () => {
            const id = item.dataset.id;
            elements.codeInput.value = id;
            validateLanding();
            if (elements.nameInput.value.trim()) {
                elements.joinBtn.click();
            } else {
                elements.nameInput.focus();
                showToast('Enter your name first', 'info');
            }
        };
    });
});

// Start discovering rooms
engine.discoverRooms();

// ─────────────────────────────────────────────────────────────
// ROOM SCREEN
// ─────────────────────────────────────────────────────────────

function enterRoom(roomId) {
    elements.landingView.classList.add('hidden');
    elements.roomView.classList.remove('hidden');
    elements.roomCode.textContent = roomId;
    setConnectionStatus('connecting');
}

function exitRoom() {
    engine.leaveRoom();
    elements.roomView.classList.add('hidden');
    elements.landingView.classList.remove('hidden');
    elements.codeInput.value = '';
    elements.fileSection.classList.add('hidden');
    elements.fileList.innerHTML = '';
    engine.discoverRooms();
}

elements.leaveBtn.onclick = exitRoom;

elements.copyBtn.onclick = async () => {
    try {
        await navigator.clipboard.writeText(elements.roomCode.textContent);
        showToast('Room code copied!', 'success');
    } catch (err) {
        showToast('Unable to copy to clipboard', 'error');
        console.error('Copy failed:', err);
    }
};

// Connection Status
function setConnectionStatus(state) {
    const dot = elements.connectionStatus.querySelector('.dot');
    const text = elements.connectionStatus.querySelector('.text');

    dot.className = 'dot';
    switch (state) {
        case 'connecting':
            text.textContent = 'Connecting...';
            dot.classList.add('yellow');
            break;
        case 'online':
            text.textContent = 'Online';
            dot.classList.add('green');
            break;
        case 'connected':
            text.textContent = 'Connected';
            dot.classList.add('blue');
            break;
        case 'disconnected':
        case 'error':
            text.textContent = 'Disconnected';
            dot.classList.add('red');
            break;
    }
}

engine.on('ready', () => setConnectionStatus('online'));
engine.on('connected', () => setConnectionStatus('connected'));
engine.on('peerJoined', () => setConnectionStatus('connected'));
engine.on('peerLeft', ({ peerId }) => {
    if (engine.peerCount === 0) setConnectionStatus('online');
});
engine.on('disconnected', () => {
    setConnectionStatus('disconnected');
    showToast('Connection lost. Reconnecting...', 'error');
});

// Participants
engine.on('participantsUpdated', (participants) => {
    elements.peerCount.textContent = participants.length;

    // Filter out self to check if room is "empty" of other peers
    const others = participants.filter(p => !p.isSelf);

    if (others.length === 0) {
        elements.participantList.innerHTML = `
            <div class="empty-state small">
                <i class="ph ph-users" style="font-size: 24px; margin-bottom: 8px; opacity: 0.5;"></i>
                <div>Waiting for others to join...</div>
            </div>
            ${renderParticipant(participants.find(p => p.isSelf))}
        `;
    } else {
        elements.participantList.innerHTML = participants.map(renderParticipant).join('');
    }
});

function renderParticipant(p) {
    if (!p) return '';
    return `
        <div class="participant ${p.isSelf ? 'self' : ''}">
            <div class="avatar">${p.name.substring(0, 2).toUpperCase()}</div>
            <span class="name">${p.name}${p.isSelf ? ' (You)' : ''}</span>
            ${p.isHost ? '<span class="role">HOST</span>' : ''}
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────
// FILE HANDLING
// ─────────────────────────────────────────────────────────────

// Drag & Drop
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    elements.dropZone.addEventListener(evt, e => e.preventDefault());
});

elements.dropZone.addEventListener('dragover', () => elements.dropZone.classList.add('active'));
elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('active'));
elements.dropZone.addEventListener('drop', (e) => {
    elements.dropZone.classList.remove('active');
    if (e.dataTransfer.files.length) {
        engine.addFiles(e.dataTransfer.files);
    }
});

elements.browseBtn.onclick = () => elements.fileInput.click();
elements.fileInput.onchange = () => {
    if (elements.fileInput.files.length) {
        engine.addFiles(elements.fileInput.files);
        elements.fileInput.value = '';
    }
};

// File List
engine.on('filesAvailable', (files) => {
    elements.fileSection.classList.remove('hidden');

    if (files.length === 0) {
        elements.fileList.innerHTML = `
            <div class="empty-state">
                <i class="ph ph-files" style="font-size: 32px; margin-bottom: 12px; opacity: 0.3;"></i>
                <div>No files shared yet</div>
                <div style="font-size: 12px; opacity: 0.7; margin-top: 4px">Drop files above to start sharing</div>
            </div>
        `;
        updateButtons();
        return;
    }

    const myFiles = files.filter(f => f.isLocal);
    const remoteFiles = files.filter(f => !f.isLocal);

    elements.fileList.innerHTML = files.map(f => `
        <div class="file-item ${f.isLocal ? 'local' : ''}" data-index="${f.index}" data-peer="${f.peerId}" data-local="${f.isLocal}">
            <input type="checkbox" class="file-check" ${f.isLocal ? '' : 'checked'}>
            <i class="ph ${f.isLocal ? 'ph-file' : 'ph-file-arrow-down'}"></i>
            <div class="file-info">
                <div class="file-name">${f.name}</div>
                <div class="file-meta">
                    ${formatBytes(f.size)} · ${f.senderName}
                    ${f.isLocal ? '<span class="tag shared">Sharing</span>' : ''}
                </div>
            </div>
            <div class="file-status" id="status-${f.peerId}-${f.index}"></div>
        </div>
    `).join('');

    updateButtons();

    // Checkbox handlers
    elements.fileList.querySelectorAll('.file-check').forEach(cb => {
        cb.onchange = updateButtons;
    });
});

function updateButtons() {
    // Download button for remote files
    const remoteChecked = elements.fileList.querySelectorAll('.file-item:not(.local) .file-check:checked');
    if (remoteChecked.length > 0) {
        elements.downloadBtn.classList.remove('hidden');
        elements.downloadBtn.innerHTML = `<i class="ph ph-download"></i> Download (${remoteChecked.length})`;
    } else {
        elements.downloadBtn.classList.add('hidden');
    }

    // Stop sharing button for local files
    const localChecked = elements.fileList.querySelectorAll('.file-item.local .file-check:checked');
    if (localChecked.length > 0) {
        elements.stopSharingBtn.classList.remove('hidden');
        elements.stopSharingBtn.innerHTML = `<i class="ph ph-prohibit"></i> Stop Sharing (${localChecked.length})`;
    } else {
        elements.stopSharingBtn.classList.add('hidden');
    }
}

elements.downloadBtn.onclick = () => {
    const requests = Array.from(elements.fileList.querySelectorAll('.file-item:not(.local) .file-check:checked')).map(cb => {
        const item = cb.closest('.file-item');
        return {
            peerId: item.dataset.peer,
            fileIndex: parseInt(item.dataset.index)
        };
    });
    if (requests.length > 0) {
        engine.downloadFiles(requests);
        showToast(`Downloading ${requests.length} file(s)...`, 'info');
    }
};

elements.stopSharingBtn.onclick = () => {
    const indices = Array.from(elements.fileList.querySelectorAll('.file-item.local .file-check:checked'))
        .map(cb => parseInt(cb.closest('.file-item').dataset.index));
    if (indices.length > 0) {
        engine.removeFiles(indices);
        showToast(`Stopped sharing ${indices.length} file(s)`, 'info');
    }
};

// Progress
engine.on('progress', ({ fileIndex, peerId, percent, speed }) => {
    const el = $(`status-${peerId}-${fileIndex}`);
    if (el) {
        el.innerHTML = `<span class="progress-text">${percent}% · ${formatBytes(speed)}/s</span>`;
    }
});

engine.on('complete', ({ fileIndex, peerId, name }) => {
    const el = $(`status-${peerId}-${fileIndex}`);
    if (el) {
        el.innerHTML = '<i class="ph ph-check-circle" style="color: #10b981"></i>';
    }
    showToast(`Downloaded: ${name}`, 'success');
});

engine.on('transferCancelled', ({ fileIndex, peerId }) => {
    const el = $(`status-${peerId}-${fileIndex}`);
    if (el) {
        el.innerHTML = '<span style="color: var(--muted)">Cancelled</span>';
    }
});

engine.on('error', (msg) => {
    showToast(msg, 'error');
    if (msg.includes('not found') || msg.includes('disconnected')) {
        exitRoom();
    }
});

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function showToast(message, type = 'info') {
    const container = $('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = { info: 'info', success: 'check-circle', error: 'warning-circle' };
    toast.innerHTML = `<i class="ph ph-${icons[type]}"></i><span>${message}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Cleanup on page unload
window.addEventListener('beforeunload', () => engine.leaveRoom());
