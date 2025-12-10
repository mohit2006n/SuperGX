const CONFIG = {
    // 128KB - Doubled for speed
    CHUNK_SIZE: 128 * 1024,
    // 1MB to prevent bufferbloat/crashes
    BUFFER_HI_WATER: 1024 * 1024,
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
        this.activeDownload = null; // { id, start, chunks, receivedCount, totalChunks, bytesRx }

        // Signaling Helpers
        this.candidates = new Map(); // Buffer for early candidates

        this.init();
    }

    // ─────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────

    // Subscribe to events
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
        if (!this.incoming) return;
        const totalChunks = Math.ceil(this.incoming.fileSize / CONFIG.CHUNK_SIZE);

        // Pre-allocate array for unordered chunks
        this.activeDownload = {
            id: hostId,
            start: Date.now(),
            chunks: new Array(totalChunks),
            receivedCount: 0,
            totalChunks,
            bytesRx: 0
        };
        this.socket.emit('accept-file', { targetId: hostId });
    }

    // ─────────────────────────────────────────────────────────────
    // INTERNAL LOGIC (Renamed for brevity)
    // ─────────────────────────────────────────────────────────────

    emit(event, data) {
        this.listeners[event]?.forEach(fn => fn(data));
    }

    init() {
        const s = this.socket;

        // Session
        s.on('id-created', (id) => { this.roomId = id; this.emit('roomCreated', id); });
        s.on('sender-info', ({ senderId }) => this.dial(senderId));
        s.on('id-not-found', () => this.emit('error', 'Session not found'));

        // Peers
        s.on('peer-joined', ({ peerId }) => this.joined(peerId));
        s.on('peer-disconnected', ({ peerId }) => this.left(peerId));

        // Signaling
        s.on('rtc-offer', async d => {
            const p = this.peer(d.senderId);
            // Host is receiver of the Offer (passive), so it waits for channel
            p.ondatachannel = e => this.bind(d.senderId, e.channel);
            await p.setRemoteDescription(d.offer);
            this.flush(d.senderId);
            const ans = await p.createAnswer();
            await p.setLocalDescription(ans);
            s.emit('rtc-answer', { targetId: d.senderId, answer: ans });
        });

        s.on('rtc-answer', d => this.peers.get(d.senderId)?.setRemoteDescription(d.answer));

        s.on('rtc-ice-candidate', d => {
            const p = this.peers.get(d.senderId);
            if (p?.remoteDescription) p.addIceCandidate(d.candidate);
            else (this.candidates.get(d.senderId) || (this.candidates.set(d.senderId, []) && this.candidates.get(d.senderId))).push(d.candidate);
        });

        // File Meta
        s.on('incoming-file', d => { this.incoming = d; this.emit('incomingFile', d); });
        s.on('file-accepted', d => this.push(d.senderId));
    }

    joined(peerId) {
        this.emit('peerJoined', peerId);
        // If I am Host, send the file info immediately to the new peer
        if (this.isHost && this.hostedFile) {
            this.socket.emit('send-file-info', {
                targetId: peerId,
                fileName: this.hostedFile.name,
                fileSize: this.hostedFile.size,
                fileType: this.hostedFile.type
            });
        }
    }

    left(peerId) {
        this.kill(peerId);
        this.emit('peerDisconnected', peerId);
    }

    async dial(targetId) {
        const p = this.peer(targetId);
        // UNORDERED Mode for Max Speed
        const dc = p.createDataChannel('file', { ordered: false, maxRetransmits: 0 });
        this.bind(targetId, dc);

        const offer = await p.createOffer();
        await p.setLocalDescription(offer);
        this.socket.emit('rtc-offer', { targetId, offer });
    }

    peer(id) {
        if (this.peers.has(id)) return this.peers.get(id);
        const p = new RTCPeerConnection({ iceServers: CONFIG.ICE_SERVERS });
        p.onicecandidate = e => e.candidate && this.socket.emit('rtc-ice-candidate', { targetId: id, candidate: e.candidate });
        p.onconnectionstatechange = () => {
            if (['failed', 'closed', 'disconnected'].includes(p.connectionState)) {
                this.left(id); // Use left() to handle cleanup & emit
            }
        };
        this.peers.set(id, p);
        return p;
    }

    kill(id) {
        this.peers.get(id)?.close();
        this.peers.delete(id);
        this.channels.delete(id);
    }

    flush(id) {
        const q = this.candidates.get(id);
        if (q) { q.forEach(c => this.peers.get(id)?.addIceCandidate(c)); this.candidates.delete(id); }
    }

    bind(id, dc) {
        this.channels.set(id, dc);
        dc.binaryType = 'arraybuffer';
        dc.onmessage = e => this.pull(id, e.data);
    }

    // ─────────────────────────────────────────────────────────────
    // TRANSFER ENGINE (Unordered + Manual Sequencing)
    // ─────────────────────────────────────────────────────────────

    async push(targetId) {
        if (!this.hostedFile) return;
        const dc = this.channels.get(targetId);
        if (!dc) return;

        const file = this.hostedFile;
        this.emit('progress', { targetId, percent: 0 });

        let chunkIndex = 0;
        let offset = 0;
        const total = file.size;
        let isPumping = false;

        // Set low watermark
        dc.bufferedAmountLowThreshold = CONFIG.CHUNK_SIZE;

        const pump = async () => {
            if (isPumping) return;
            isPumping = true;

            // Drain buffer while we have space
            while (dc.bufferedAmount <= CONFIG.BUFFER_HI_WATER && offset < total) {
                try {
                    const chunkData = await file.slice(offset, offset + CONFIG.CHUNK_SIZE).arrayBuffer();

                    // Prepend 4-byte Index
                    const packet = new Uint8Array(4 + chunkData.byteLength);
                    const view = new DataView(packet.buffer);
                    view.setUint32(0, chunkIndex, false); // Big Endian
                    packet.set(new Uint8Array(chunkData), 4);

                    dc.send(packet);

                    offset += chunkData.byteLength;
                    chunkIndex++;

                    // Optimize: Check progress every ~1MB
                    if (offset % (CONFIG.CHUNK_SIZE * 16) === 0 || offset === total) {
                        this.emit('progress', { targetId, percent: Math.round(offset / total * 100) });
                    }
                } catch (e) {
                    // console.warn('Queue full, waiting...');
                    dc.onbufferedamountlow = pump;
                    isPumping = false;
                    return;
                }
            }

            if (offset < total) {
                dc.onbufferedamountlow = pump;
                isPumping = false;
            } else {
                // Done - Send strict DONE signal
                dc.send('DONE');
                this.emit('complete', { targetId });
                clearInterval(watchdog);
            }
        };

        pump();

        // Safety Watchdog: Kick pump if stuck idle
        const watchdog = setInterval(() => {
            if (offset < total && dc.bufferedAmount <= CONFIG.BUFFER_HI_WATER && !isPumping) {
                pump();
            }
        }, 1000);
    }

    pull(id, data) {
        if (typeof data === 'string' && data === 'DONE') {
            this.save(id);
            return;
        }

        const t = this.activeDownload;
        if (!t || t.id !== id) return;

        // Parse Index
        const view = new DataView(data);
        const index = view.getUint32(0, false);
        const payload = data.slice(4); // Remove header (ArrayBuffer)

        // Store - OPTIMIZATION: Store ArrayBuffer directly. 
        if (!t.chunks[index]) {
            t.chunks[index] = payload;
            t.receivedCount++;
            t.bytesRx += payload.byteLength;
        }

        const now = Date.now();
        if (!t.lastUpdate || now - t.lastUpdate > 200) {
            const time = (now - t.start) / 1000;
            const speed = time > 0 ? (t.bytesRx / time) : 0;
            const pct = Math.round(t.receivedCount / t.totalChunks * 100);

            this.emit('progress', { targetId: id, percent: pct, speed });
            t.lastUpdate = now;
        }

        if (t.receivedCount === t.totalChunks) {
            this.save(id);
        }
    }

    save(id) {
        const t = this.activeDownload;
        if (!t) return;

        // Assemble in order (Instant now)
        const blob = new Blob(t.chunks);

        this.emit('complete', {
            blob,
            fileName: this.incoming?.fileName || 'download',
            targetId: id
        });

        this.activeDownload = null;
    }
}