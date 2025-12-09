import { Supr } from './supr.js';

// Init
const socket = io();
const supr = new Supr(socket);

// DOM Elements
const $ = id => document.getElementById(id);
const views = { host: $('view-host'), client: $('view-client') };
const els = {
    drop: $('drop-zone'),
    input: $('file-input'),
    info: $('share-info'),
    fname: $('host-filename'),
    link: $('share-link'),
    copy: $('copy-btn'),
    peers: $('peer-container'),

    // Client
    status: $('client-status'),
    cfname: $('client-filename'),
    csize: $('client-filesize'),
    dlBtn: $('download-btn'),
    prog: $('client-progress'),
    bar: document.querySelector('.fill'),
    pct: $('prog-percent'),
    spd: $('prog-speed')
};

// State
const peers = new Set();
const updatePeers = () => els.peers.textContent = `${peers.size} Peer${peers.size === 1 ? '' : 's'} connected`;

// ─────────────────────────────────────────────────────────────
// ROUTING
// ─────────────────────────────────────────────────────────────
const params = new URLSearchParams(window.location.search);
const id = params.get('id');

if (id) {
    // CLIENT
    views.host.classList.add('hidden');
    views.client.classList.remove('hidden');
    supr.joinSession(id);
} else {
    // HOST
    // Wait for user to pick file
}

// ─────────────────────────────────────────────────────────────
// HOST LOGIC
// ─────────────────────────────────────────────────────────────
const handleFile = (file) => {
    if (!file) return;
    supr.hostFile(file);
};

// UI Events
els.drop.onclick = () => els.input.click();
els.input.onchange = () => handleFile(els.input.files[0]);
els.copy.onclick = () => {
    navigator.clipboard.writeText(els.link.value);
    const prev = els.copy.textContent;
    els.copy.textContent = 'Copied!';
    setTimeout(() => els.copy.textContent = prev, 1000);
};

// Drag & Drop
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(e => {
    els.drop.addEventListener(e, ev => { ev.preventDefault(); ev.stopPropagation(); });
});
els.drop.addEventListener('drop', e => handleFile(e.dataTransfer.files[0]));


// ─────────────────────────────────────────────────────────────
// SDK EVENTS
// ─────────────────────────────────────────────────────────────

// 1. Session Ready (Host)
supr.on('roomCreated', (roomId) => {
    els.drop.classList.add('minimized');
    els.info.classList.remove('hidden');
    els.fname.textContent = `${supr.hostedFile.name} (${formatBytes(supr.hostedFile.size)})`;
    els.link.value = `${window.location.origin}/?id=${roomId}`;
});

// 2. Incoming Offer (Client)
let hostPeerId = null;
supr.on('incomingFile', (meta) => {
    hostPeerId = meta.senderId;
    els.status.textContent = 'Ready';
    els.status.className = 'status-badge ready';
    els.cfname.textContent = meta.fileName;
    els.csize.textContent = formatBytes(meta.fileSize);
    els.dlBtn.disabled = false;
});

// 3. User Clicked Download (Client)
els.dlBtn.onclick = () => {
    if (!hostPeerId) return;
    supr.acceptFile(hostPeerId);
    els.dlBtn.classList.add('hidden');
    els.prog.classList.remove('hidden');
    els.status.textContent = 'Downloading...';
};

// 4. Progress (Both)
supr.on('progress', (d) => {
    // Client UI
    if (!views.client.classList.contains('hidden')) {
        els.bar.style.width = `${d.percent}%`;
        els.pct.textContent = `${d.percent}%`;
        if (d.speed) els.spd.textContent = `${formatBytes(d.speed)}/s`;
    }
});

// 5. Complete (Both)
supr.on('complete', (d) => {
    if (d.blob) {
        // Client: Save
        els.status.textContent = 'Done';
        els.status.className = 'status-badge success';
        els.spd.textContent = 'Completed';

        const url = URL.createObjectURL(d.blob);
        const a = document.createElement('a');
        a.href = url; a.download = d.fileName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } else {
        // Host: Just toast or ignore
    }
});

// 6. Peers (Host)
supr.on('peerJoined', (pid) => {
    if (!peers.has(pid)) {
        peers.add(pid);
        updatePeers();
    }
});
supr.on('peerDisconnected', (pid) => {
    if (peers.has(pid)) {
        peers.delete(pid);
        updatePeers();
    }
});
// Utils
function formatBytes(bytes) {
    if (!bytes) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + ' ' + ['B', 'KB', 'MB', 'GB'][i];
}

const showToast = (msg) => {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    t.style.cssText = 'position:fixed;top:10px;right:10px;background:#000;color:#fff;padding:10px;z-index:9999;';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
};

supr.on('error', (msg) => showToast(msg));
