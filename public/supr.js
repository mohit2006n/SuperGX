const CONFIG = {
    // 256KB for higher throughput (matches high-speed example)
    CHUNK_SIZE: 256 * 1024,
    // 16MB buffer limit for backpressure
    BUFFER_HI_WATER: 16 * 1024 * 1024,
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

export class Supr {
    constructor(socket) {
        this.socket = socket;
        this.peers = new Map();     // id -> RTCPeerConnection
        this.channels = new Map();  // id -> RTCDataChannel
        this.listeners = {};

        // Host State
        this.isHost = false;
        this.hostedFile = null;
        this.roomId = null;

        // Client State
        this.activeDownload = null; // { id, start, chunks, partSize, totalRx }

        // Signaling Helpers
        this.candidates = new Map(); // Buffer for early candidates

        this._initSocket();
    }

    // ─────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────

    // Subscribe to events: 'roomCreated', 'peerJoined', 'peerDisconnected', 'incomingFile', 'progress', 'complete'
    on(event, fn) { (this.listeners[event] ||= []).push(fn); }

    // Host: Start a session
    hostFile(file) {
        this.isHost = true;
        this.hostedFile = file;
        // Generate short ID for room
        const id = Math.random().toString(36).substring(2, 8);
        this.socket.emit('create-id', { id });
    }

    // Client: Join a session
    joinSession(id) {
        this.socket.emit('join-id', id);
    }

    // Client: Accept file transfer
    acceptFile(hostId) {
        // Reset download state
        this.activeDownload = {
            id: hostId,
            start: Date.now(),
            rx: 0,
            chunks: [],
            parts: []
        };
        this.socket.emit('accept-file', { targetId: hostId });
    }

    // ─────────────────────────────────────────────────────────────
    // INTERNAL LOGIC
    // ─────────────────────────────────────────────────────────────

    emit(event, data) {
        this.listeners[event]?.forEach(fn => fn(data));
    }

    _initSocket() {
        const s = this.socket;

        // Session
        s.on('id-created', (id) => { this.roomId = id; this.emit('roomCreated', id); });
        s.on('sender-info', ({ senderId }) => this._initiateP2P(senderId));
        s.on('id-not-found', () => this.emit('error', 'Session not found'));

        // Peers
        s.on('peer-joined', ({ peerId }) => this.emit('peerJoined', peerId));
        s.on('peer-disconnected', ({ message }) => this.emit('error', message));

        // Signaling
        s.on('rtc-offer', async d => {
            const p = this._getPeer(d.senderId);
            // Host is receiver of the Offer (passive), so it waits for channel
            p.ondatachannel = e => this._setupChannel(d.senderId, e.channel, false);
            await p.setRemoteDescription(d.offer);
            this._flushCandidates(d.senderId);
            const ans = await p.createAnswer();
            await p.setLocalDescription(ans);
            s.emit('rtc-answer', { targetId: d.senderId, answer: ans });
        });

        s.on('rtc-answer', d => this.peers.get(d.senderId)?.setRemoteDescription(d.answer));

        s.on('rtc-ice-candidate', d => {
            const p = this.peers.get(d.senderId);
            // Only add if we have a remote description, else buffer
            if (p?.remoteDescription) p.addIceCandidate(d.candidate);
            else (this.candidates.get(d.senderId) || (this.candidates.set(d.senderId, []) && this.candidates.get(d.senderId))).push(d.candidate);
        });

        // File Meta
        s.on('incoming-file', d => { this.incoming = d; this.emit('incomingFile', d); });
        s.on('file-accepted', d => this._startUpload(d.senderId));
    }

    async _initiateP2P(targetId) {
        const p = this._getPeer(targetId);
        // Client initiates the data channel (Caller)
        const dc = p.createDataChannel('file', { ordered: true });
        this._setupChannel(targetId, dc, true);

        const offer = await p.createOffer();
        await p.setLocalDescription(offer);
        this.socket.emit('rtc-offer', { targetId, offer });
    }

    _getPeer(id) {
        if (this.peers.has(id)) return this.peers.get(id);
        const p = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
        p.onicecandidate = e => e.candidate && this.socket.emit('rtc-ice-candidate', { targetId: id, candidate: e.candidate });
        p.onconnectionstatechange = () => {
            if (['failed', 'closed', 'disconnected'].includes(p.connectionState)) {
                this._cleanupPeer(id);
                this.emit('peerDisconnected', id);
            }
        };
        this.peers.set(id, p);
        return p;
    }

    _cleanupPeer(id) {
        this.peers.get(id)?.close();
        this.peers.delete(id);
        this.channels.delete(id);
    }

    _flushCandidates(id) {
        const q = this.candidates.get(id);
        if (q) { q.forEach(c => this.peers.get(id)?.addIceCandidate(c)); this.candidates.delete(id); }
    }

    _setupChannel(id, dc, isInitiator) {
        this.channels.set(id, dc);
        dc.binaryType = 'arraybuffer';
        dc.onmessage = e => this._handleData(id, e.data);

        dc.onopen = () => {
            // Once connected, if I am Host, I send my file info
            if (!isInitiator && this.hostedFile) {
                this.socket.emit('send-file-info', {
                    targetId: id,
                    fileName: this.hostedFile.name,
                    fileSize: this.hostedFile.size,
                    fileType: this.hostedFile.type
                });
            }
        };
    }

    // ─────────────────────────────────────────────────────────────
    // TRANSFER ENGINE
    // ─────────────────────────────────────────────────────────────

    async _startUpload(targetId) {
        if (!this.hostedFile) return;
        const dc = this.channels.get(targetId);
        if (!dc) return;

        const file = this.hostedFile;
        this.emit('progress', { targetId, percent: 0 });

        let offset = 0;
        const total = file.size;

        // Loop: Read -> Send -> Yield (if full)
        while (offset < total) {
            // Backpressure: If buffer is full, wait 0ms (yield to event loop)
            // If very full, might want 10ms, but 0ms usually clears fast enough on LAN
            if (dc.bufferedAmount > CONFIG.BUFFER_HI_WATER) {
                await new Promise(r => setTimeout(r, 0));
                continue;
            }

            try {
                const chunk = await file.slice(offset, offset + CONFIG.CHUNK_SIZE).arrayBuffer();
                dc.send(chunk);
                offset += chunk.byteLength;

                // Emit progress sparingly (every ~640KB) or at end
                if (offset % (CONFIG.CHUNK_SIZE * 10) === 0 || offset === total) {
                    this.emit('progress', { targetId, percent: Math.round(offset / total * 100) });
                }
            } catch (e) {
                // Buffer overflow or network hiccup, retry after small pause
                await new Promise(r => setTimeout(r, 10));
            }
        }

        dc.send('DONE');
        this.emit('complete', { targetId });
    }

    _handleData(id, data) {
        if (typeof data === 'string' && data === 'DONE') {
            this._finalizeDownload(id);
            return;
        }

        const t = this.activeDownload;
        if (!t || t.id !== id) return;

        t.chunks.push(data);
        t.rx += data.byteLength;

        // Auto-complete check
        if (this.incoming && t.rx >= this.incoming.fileSize) {
            this._finalizeDownload(id);
            return;
        }

        // Incremental Consolidation to keep RAM usage low
        if (t.chunks.length >= 50) {
            (t.parts ||= []).push(new Blob(t.chunks));
            t.chunks = [];
        }

        // Throttle progress updates (every 200ms)
        const now = Date.now();
        if (!t.lastUpdate || now - t.lastUpdate > 200) {
            const time = (now - t.start) / 1000;
            const speed = time > 0 ? (t.rx / time) : 0;
            this.emit('progress', {
                targetId: id, // for receiver UI consistency
                percent: Math.round(t.rx / this.incoming.fileSize * 100),
                speed
            });
            t.lastUpdate = now;
        }
    }

    _finalizeDownload(id) {
        const t = this.activeDownload;
        if (!t) return;

        // Combine all parts
        const finalParts = (t.parts || []).concat(t.chunks.length ? [new Blob(t.chunks)] : []);
        const blob = new Blob(finalParts);

        this.emit('complete', {
            blob,
            fileName: this.incoming?.fileName || 'download',
            targetId: id
        });

        this.activeDownload = null;
    }
}