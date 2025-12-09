import { Supr } from './supr.js';

// Init
const socket = io(); // Allow auto-transport (Polling -> WebSocket)
const supr = new Supr(socket, { SPEED_LIMIT: 0 });

// DOM
const $ = id => document.getElementById(id);
const views = {
    host: $('view-host'),
    client: $('view-client')
};
const els = {
    dropZone: $('drop-zone'),
    fileInput: $('file-input'),
    shareInfo: $('share-info'),
    hostFilename: $('host-filename'),
    shareLink: $('share-link'),
    copyBtn: $('copy-btn'),
    peerContainer: $('peer-container'),

    // Client
    clientStatus: $('client-status'),
    clientFilename: $('client-filename'),
    clientFilesize: $('client-filesize'),
    downloadBtn: $('download-btn'),
    clientProgress: $('client-progress'),
    progFill: document.querySelector('.fill'),
    progPercent: $('prog-percent'),
    progSpeed: $('prog-speed')
};

// Utils
const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
};
const showToast = (msg) => {
    const t = document.createElement('div'); t.className = 'toast show'; t.textContent = msg;
    $('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3000);
};

// Routing
const urlParams = new URLSearchParams(window.location.search);
let roomId = urlParams.get('id');

if (roomId) {
    // CLIENT MODE
    views.host.classList.add('hidden');
    views.client.classList.remove('hidden');
    initClient();
} else {
    // HOST MODE
    initHost();
}

// ─────────────────────────────────────────────────────────────
// HOST LOGIC
// ─────────────────────────────────────────────────────────────
function initHost() {
    roomId = Math.random().toString(36).substring(2, 8);
    supr.joinRoom(roomId);

    // File Selection
    const handleFile = (file) => {
        if (!file) return;
        supr.hostFile(file);

        // Update UI
        els.dropZone.classList.add('minimized');
        els.shareInfo.classList.remove('hidden');
        els.hostFilename.textContent = `${file.name} (${formatBytes(file.size)})`;
        els.shareLink.value = `${window.location.origin}/?id=${roomId}`;

        showToast('Link ready! Share it.');
    };

    els.dropZone.onclick = () => els.fileInput.click();
    els.fileInput.onchange = () => handleFile(els.fileInput.files[0]);

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
        els.dropZone.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); });
    });
    els.dropZone.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));

    els.copyBtn.onclick = () => {
        navigator.clipboard.writeText(els.shareLink.value);
        showToast('Link copied!');
        els.copyBtn.classList.add('success');
        setTimeout(() => els.copyBtn.classList.remove('success'), 1000);
    };

    // Events
    supr.on('peerJoined', (peerId) => {
        // Add to peer list
        const pill = document.createElement('div');
        pill.className = 'peer-pill';
        pill.innerHTML = '<div class="dot green"></div> Peer ' + peerId.substring(0, 4);
        pill.id = `peer-${peerId}`;
        els.peerContainer.appendChild(pill);
        showToast('A peer joined!');
    });

    supr.on('uploadProgress', d => {
        // Find peer pill and show progress? For now just toast or minimal indicator
        const pill = $(`peer-${d.targetId}`);
        if (pill) pill.style.background = `linear-gradient(90deg, rgba(0,255,100,0.1) ${d.percent}%, var(--surface-2) ${d.percent}%)`;
    });

    supr.on('transferComplete', d => {
        const pill = $(`peer-${d.targetId}`);
        if (pill) pill.innerHTML = '<div class="dot blue"></div> Complete';
    });
}

// ─────────────────────────────────────────────────────────────
// CLIENT LOGIC
// ─────────────────────────────────────────────────────────────
function initClient() {
    supr.joinRoom(roomId);

    let hostId = null;

    supr.on('incomingFile', d => {
        hostId = d.senderId;
        els.clientStatus.textContent = 'Ready to download';
        els.clientStatus.className = 'status-badge ready';
        els.clientFilename.textContent = d.fileName;
        els.clientFilesize.textContent = formatBytes(d.fileSize);
        els.downloadBtn.disabled = false;

        // Auto-start or wait for click? Request implied wait for click.
    });

    els.downloadBtn.onclick = () => {
        if (!hostId) return;
        supr.downloadFile(hostId);
        els.downloadBtn.classList.add('hidden');
        els.clientProgress.classList.remove('hidden');
        els.clientStatus.textContent = 'Downloading...';
    };

    supr.on('downloadProgress', d => {
        els.progFill.style.width = `${d.percent}%`;
        els.progPercent.textContent = `${d.percent}%`;
        els.progSpeed.textContent = `${formatBytes(d.speed)}/s`;
    });

    supr.on('fileReceived', ({ blob, fileName }) => {
        els.clientStatus.textContent = 'Completed';
        els.clientStatus.className = 'status-badge success';

        // Save
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        showToast('Download complete!');
    });
}
