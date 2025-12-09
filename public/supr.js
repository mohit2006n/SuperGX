const DEFAULTS = {
    RTC_CHUNK_SIZE: 64 * 1024,
    SOCKET_CHUNK_SIZE: 256 * 1024,
    BUFFER_LIMIT: 16 * 1024 * 1024, // 16MB
    YIELD_INTERVAL: 1024 * 1024, // 1MB
    SPEED_LIMIT: 0,
    ICE_SERVERS: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' }
    ]
};

export class Supr {
    constructor(socket, config = {}) {
        this.socket = socket;
        this.config = { ...DEFAULTS, ...config };

        // Maps
        this.peers = new Map(); // id -> RTCPeerConnection
        this.channels = new Map(); // id -> RTCDataChannel
        this.listeners = {};

        // State
        this.roomId = null;
        this.isHost = false;

        // Hosting State (I am Sender)
        this.hostedFile = null; // { file, meta }
        this.activeUploads = new Map(); // id -> { offset, ... }

        // Client State (I am Receiver)
        this.activeDownload = null; // { id, chunks, ... }

        // Socket Events
        socket.on('connect', () => {
            if (this.self) this.announce(this.self);
            if (this.roomId) this.socket.emit('join-room', this.roomId);
        });
        socket.on('peer-joined', ({ peerId }) => this.handlePeerJoined(peerId));

        // WebRTC
        socket.on('rtc-offer', async d => {
            const p = this.getPeer(d.senderId);
            p.ondatachannel = e => this.setupChannel(d.senderId, e.channel);
            await p.setRemoteDescription(d.offer);
            const ans = await p.createAnswer();
            await p.setLocalDescription(ans);
            socket.emit('rtc-answer', { targetId: d.senderId, answer: ans });
        });
        socket.on('rtc-answer', d => this.peers.get(d.senderId)?.setRemoteDescription(d.answer));
        socket.on('rtc-ice-candidate', d => this.peers.get(d.senderId)?.addIceCandidate(d.candidate));

        // Transfer Handshake
        socket.on('incoming-file', d => {
            this.incoming = d;
            this.emit('incomingFile', d);
        });
        socket.on('file-accepted', d => this.startUpload(d.senderId)); // Host: Client accepted

        // Data
        socket.on('file-chunk', d => this.receiveChunk(d.senderId, d.data));
        socket.on('file-complete', d => this.receiveDone(d.senderId));
    }

    // Public API
    on(e, fn) { (this.listeners[e] ||= []).push(fn); }
    emit(e, d) { this.listeners[e]?.forEach(fn => fn(d)); }

    joinRoom(id) {
        this.roomId = id;
        this.socket.emit('join-room', id);
    }

    // HOST: Set the file to be shared
    hostFile(file) {
        this.hostedFile = file;
        this.isHost = true;
        // If I am hosting, I wait for peers to join.
    }

    // CLIENT: Accept the file offered by host
    downloadFile(hostId) {
        this.activeDownload = {
            id: hostId,
            chunks: [],
            parts: [],
            rx: 0,
            start: Date.now()
        };
        this.socket.emit('accept-file', { targetId: hostId });
    }

    // Internal Logic
    handlePeerJoined(peerId) {
        this.emit('peerJoined', peerId);
        // If I am Host and have a file, Offer it immediately
        if (this.isHost && this.hostedFile) {
            const f = this.hostedFile;
            this.socket.emit('send-file-info', {
                targetId: peerId,
                fileName: f.name,
                fileSize: f.size,
                fileType: f.type
            });
        }
    }

    // Host: Start sending to a specific target
    async startUpload(targetId) {
        if (!this.hostedFile) return;
        const file = this.hostedFile;
        // Unique state per target
        const uploadState = { targetId, start: Date.now() };
        this.activeUploads.set(targetId, uploadState);
        this.emit('transferStarted', { targetId, fileName: file.name });

        const cfg = this.config;

        try {
            // P2P
            const dc = await this.connectP2P(targetId);
            await this.stream(file, d => dc.send(d), async (off) => {
                while (dc.bufferedAmount > cfg.BUFFER_LIMIT) await new Promise(r => setTimeout(r, 10));
                if (cfg.YIELD_INTERVAL && off % cfg.YIELD_INTERVAL === 0) await new Promise(r => setTimeout(r, 0));
            }, cfg.RTC_CHUNK_SIZE, targetId);
            dc.send('"done"');
        } catch (e) {
            // Fallback
            await this.stream(file, d => this.socket.emit('file-chunk', { targetId, data: d }), async () => {
                if (performance.now() % 16 < 1) await new Promise(r => setTimeout(r, 0));
            }, cfg.SOCKET_CHUNK_SIZE, targetId);
            this.socket.emit('file-complete', { targetId });
        }

        this.emit('transferComplete', { targetId });
        this.activeUploads.delete(targetId);
    }

    // Generic Streamer
    async stream(file, sendFn, waitFn, chunkSize, targetId) {
        let offset = 0, lastTime = 0, start = Date.now(), limit = this.config.SPEED_LIMIT;

        while (offset < file.size) {
            if (!this.activeUploads.has(targetId)) throw 'Aborted';
            await waitFn(offset);

            const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer();
            try { sendFn(chunk); } catch { await new Promise(r => setTimeout(r, 50)); sendFn(chunk); }
            offset += chunk.byteLength;

            const now = Date.now();
            if (now - lastTime > 200 || offset === file.size) {
                const time = (now - start) / 1000;
                this.emit('uploadProgress', {
                    targetId, percent: Math.round(offset / file.size * 100),
                    speed: (offset / time) || 0
                });
                lastTime = now;
            }
            if (limit) {
                const diff = (offset / limit) - ((now - start) / 1000);
                if (diff > 0) await new Promise(r => setTimeout(r, diff * 1000));
            }
        }
    }

    // Client: Receive
    receiveChunk(id, data) {
        const t = this.activeDownload;
        if (!t || t.id !== id) return;

        t.chunks.push(data);
        t.rx += data.byteLength;
        // Incremental Consolidation
        if (t.chunks.length >= 50) {
            (t.parts ||= []).push(new Blob(t.chunks)); t.chunks = [];
        }

        const now = Date.now();
        if (now - (t.lastTime || 0) > 200) {
            this.emit('downloadProgress', {
                percent: Math.round(t.rx / this.incoming.fileSize * 100),
                speed: (t.rx / ((now - t.start) / 1000)) || 0
            });
            t.lastTime = now;
        }
    }

    receiveDone(id) {
        const t = this.activeDownload;
        if (!t || t.id !== id) return;
        const parts = t.parts || [];
        if (t.chunks.length) parts.push(new Blob(t.chunks));

        this.emit('fileReceived', {
            blob: new Blob(parts), fileName: this.incoming.fileName
        });
        this.activeDownload = null;
    }

    // WebRTC Helpers
    getPeer(id) {
        if (this.peers.has(id)) return this.peers.get(id);
        const p = new RTCPeerConnection({ iceServers: this.config.ICE_SERVERS });
        p.onicecandidate = e => e.candidate && this.socket.emit('rtc-ice-candidate', { targetId: id, candidate: e.candidate });
        p.onconnectionstatechange = () => ['failed', 'disconnected', 'closed'].includes(p.connectionState) && this.closePeer(id);
        this.peers.set(id, p);
        return p;
    }
    closePeer(id) { this.peers.get(id)?.close(); this.peers.delete(id); this.channels.delete(id); }
    setupChannel(id, c) {
        c.binaryType = 'arraybuffer';
        c.onmessage = e => typeof e.data === 'string' ? this.receiveDone(id) : this.receiveChunk(id, e.data);
        this.channels.set(id, c);
    }
    async connectP2P(id) {
        if (this.channels.get(id)?.readyState === 'open') return this.channels.get(id);
        const p = this.getPeer(id);
        const c = p.createDataChannel('file', { ordered: true });
        return new Promise((res, rej) => {
            const t = setTimeout(rej, 5000);
            c.onopen = () => { clearTimeout(t); this.setupChannel(id, c); res(c); };
            c.onerror = rej;
            p.createOffer().then(o => p.setLocalDescription(o)).then(() => this.socket.emit('rtc-offer', { targetId: id, offer: p.localDescription }));
        });
    }
}
