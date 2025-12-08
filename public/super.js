/**
 * SuperGO Engine - WebRTC P2P Zero Latency
 * Direct peer-to-peer file transfer, server used only for signaling.
 */

class SuperGO {
    constructor(config = {}) {
        this.socket = null;
        this.devices = [];
        this.myDevice = null;
        this.maxSpeed = config.maxSpeed || 0;

        // Transfer State
        this.activeTransfer = null;
        this.pendingTransfer = null;
        this.pendingTargetId = null;
        this.incomingRequest = null;

        // WebRTC State
        this.peerConnections = new Map(); // deviceId -> RTCPeerConnection
        this.dataChannels = new Map();    // deviceId -> RTCDataChannel

        // Deduplication
        this._completedTransfers = new Set();
        this._events = {};

        // P2P Mode indicator
        this.isP2P = false;

        // ICE Servers (STUN + TURN for NAT traversal)
        this.iceServers = [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            // Free TURN server (OpenRelay)
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ];
    }

    on(event, cb) {
        (this._events[event] ||= []).push(cb);
    }

    _emit(event, data) {
        const cbs = this._events[event];
        if (cbs) for (let i = 0; i < cbs.length; i++) cbs[i](data);
    }

    connect(deviceInfo) {
        this.myDevice = deviceInfo || { name: 'Unknown', type: 'desktop' };
        this.socket = io('/', {
            transports: ['websocket', 'polling'],
            upgrade: true,
            reconnection: true
        });

        this.socket.on('connect', () => {
            this.socket.emit('register', this.myDevice);
            this._emit('connected', this.myDevice);
        });

        this.socket.on('disconnect', () => {
            this._cleanup('Connection lost');
            this._emit('disconnected');
        });

        this.socket.on('devices', (list) => {
            this.devices = list;
            this._emit('devicesUpdated', list);

            // Cleanup stale peer connections
            this.peerConnections.forEach((pc, id) => {
                if (!list.some(d => d.id === id)) {
                    pc.close();
                    this.peerConnections.delete(id);
                    this.dataChannels.delete(id);
                }
            });

            // Abort if target disconnected
            if (this.activeTransfer?.targetId && !list.some(d => d.id === this.activeTransfer.targetId)) {
                this.activeTransfer.aborted = true;
            }
            if (this.activeTransfer?.senderId && !list.some(d => d.id === this.activeTransfer.senderId)) {
                this._emit('transferError', { senderId: this.activeTransfer.senderId, error: 'Sender disconnected' });
                this.activeTransfer = null;
            }
        });

        // ─────────────────────────────────────────────────────────────
        // WebRTC Signaling
        // ─────────────────────────────────────────────────────────────

        this.socket.on('rtc-offer', async (data) => {
            const pc = this._createPeerConnection(data.senderId);

            pc.ondatachannel = (event) => {
                this._setupDataChannel(data.senderId, event.channel);
            };

            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this.socket.emit('rtc-answer', { targetId: data.senderId, answer });
        });

        this.socket.on('rtc-answer', async (data) => {
            const pc = this.peerConnections.get(data.senderId);
            if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            }
        });

        this.socket.on('rtc-ice-candidate', async (data) => {
            const pc = this.peerConnections.get(data.senderId);
            if (pc && data.candidate) {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            }
        });

        // ─────────────────────────────────────────────────────────────
        // Socket.io fallback (for signaling and when WebRTC fails)
        // ─────────────────────────────────────────────────────────────

        this.socket.on('incoming-file', (data) => {
            if (this.activeTransfer || this.incomingRequest) {
                this.socket.emit('reject-file', { senderId: data.senderId, reason: 'busy' });
                return;
            }
            this.incomingRequest = data;
            this._emit('incomingFile', data);
        });

        this.socket.on('file-accepted', (data) => {
            if (this.pendingTransfer && this.pendingTargetId === data.targetId) {
                this._startP2PTransfer(data.targetId, this.pendingTransfer);
            }
        });

        this.socket.on('file-rejected', (data) => {
            this.pendingTransfer = null;
            this.pendingTargetId = null;
            this._emit('transferRejected', { reason: data?.reason || 'Rejected' });
        });

        // Fallback: Socket.io relay (when WebRTC fails)
        this.socket.on('file-chunk', (data) => this._receiveChunk(data));
        this.socket.on('file-complete', (data) => this._finalizeFile(data.senderId));
    }

    disconnect() {
        this._cleanup();
        this.peerConnections.forEach(pc => pc.close());
        this.peerConnections.clear();
        this.dataChannels.clear();
        this.socket?.disconnect();
        this.socket = null;
    }

    _cleanup(reason) {
        if (this.activeTransfer && reason) {
            const id = this.activeTransfer.targetId || this.activeTransfer.senderId;
            if (id) this._emit('transferError', { targetId: id, error: reason });
        }
        this.activeTransfer = null;
        this.pendingTransfer = null;
        this.pendingTargetId = null;
        this.incomingRequest = null;
    }

    // ─────────────────────────────────────────────────────────────
    // WebRTC Peer Connection
    // ─────────────────────────────────────────────────────────────

    _createPeerConnection(peerId) {
        const pc = new RTCPeerConnection({ iceServers: this.iceServers });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('rtc-ice-candidate', {
                    targetId: peerId,
                    candidate: event.candidate
                });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                this.peerConnections.delete(peerId);
                this.dataChannels.delete(peerId);
            }
        };

        this.peerConnections.set(peerId, pc);
        return pc;
    }

    _setupDataChannel(peerId, channel) {
        channel.binaryType = 'arraybuffer';

        channel.onmessage = (event) => {
            if (typeof event.data === 'string') {
                const msg = JSON.parse(event.data);
                if (msg.type === 'file-complete') {
                    this._finalizeFile(peerId);
                }
            } else {
                // Binary data = file chunk
                this._receiveChunk({ senderId: peerId, data: event.data });
            }
        };

        channel.onerror = (err) => {
            console.error('DataChannel error:', err);
        };

        this.dataChannels.set(peerId, channel);
    }

    async _getOrCreateDataChannel(peerId) {
        // Check if we already have an open channel
        let channel = this.dataChannels.get(peerId);
        if (channel && channel.readyState === 'open') {
            return channel;
        }

        // Create new peer connection and data channel
        const pc = this._createPeerConnection(peerId);
        channel = pc.createDataChannel('file-transfer', { ordered: true });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('WebRTC timeout')), 10000);

            channel.onopen = () => {
                clearTimeout(timeout);
                this._setupDataChannel(peerId, channel);
                resolve(channel);
            };

            channel.onerror = (err) => {
                clearTimeout(timeout);
                reject(err);
            };

            // Create and send offer
            pc.createOffer().then(offer => {
                pc.setLocalDescription(offer);
                this.socket.emit('rtc-offer', { targetId: peerId, offer });
            });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // SENDER LOGIC
    // ─────────────────────────────────────────────────────────────

    sendFile(targetId, file) {
        if (!file || !file.size) {
            this._emit('transferError', { targetId, error: 'Empty file' });
            return;
        }
        if (this.activeTransfer || this.pendingTransfer) {
            this._emit('transferError', { targetId, error: 'Already busy' });
            return;
        }

        this.pendingTransfer = file;
        this.pendingTargetId = targetId;
        this.socket.emit('send-file-info', {
            targetId, fileName: file.name, fileSize: file.size, fileType: file.type
        });
        this._emit('transferPending', { targetId, file });
    }

    async _startP2PTransfer(targetId, file) {
        this.activeTransfer = { targetId, aborted: false, startTime: Date.now() };
        this.pendingTransfer = null;
        this.pendingTargetId = null;

        try {
            // Try WebRTC first
            const channel = await this._getOrCreateDataChannel(targetId);
            this.isP2P = true;
            console.log('✓ WebRTC P2P connected - direct transfer');
            await this._sendViaDataChannel(targetId, file, channel);
        } catch (err) {
            console.warn('✗ WebRTC failed:', err.message, '- using server relay');
            this.isP2P = false;
            // Fallback to Socket.io relay
            await this._sendViaSocket(targetId, file);
        }
    }

    async _sendViaDataChannel(targetId, file, channel) {
        const total = file.size;
        const CHUNK_SIZE = 64 * 1024; // 64KB for WebRTC (optimal for data channels)
        let offset = 0;
        let lastUpdate = 0;
        let smoothSpeed = 0;
        const startTime = Date.now();

        this._emit('transferStarted', { targetId, fileName: file.name, total, isP2P: true });

        while (offset < total) {
            if (!this.activeTransfer || this.activeTransfer.aborted) {
                this.activeTransfer = null;
                this._emit('transferError', { targetId, error: 'Transfer aborted' });
                return;
            }

            // Wait if buffer is full (backpressure)
            while (channel.bufferedAmount > 16 * 1024 * 1024) {
                await new Promise(r => setTimeout(r, 10));
            }

            const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
            const buffer = await chunkBlob.arrayBuffer();
            channel.send(buffer);
            offset += buffer.byteLength;

            // Progress
            const now = Date.now();
            if (now - lastUpdate > 200 || offset === total) {
                const elapsed = (now - startTime) / 1000;
                const instantSpeed = elapsed > 0 ? offset / elapsed : 0;
                smoothSpeed = smoothSpeed === 0 ? instantSpeed : (smoothSpeed * 0.7 + instantSpeed * 0.3);

                this._emit('transferProgress', {
                    targetId, sent: offset, total,
                    percent: Math.round((offset / total) * 100),
                    speed: smoothSpeed, fileName: file.name
                });
                lastUpdate = now;
            }

            // Yield every 16ms
            if (offset % (CHUNK_SIZE * 16) === 0) {
                await new Promise(r => setTimeout(r, 0));
            }

            // Speed Limit (applies to WebRTC too)
            if (this.maxSpeed > 0) {
                const elapsed = (Date.now() - startTime) / 1000;
                const expectedTime = offset / this.maxSpeed;
                if (elapsed < expectedTime) {
                    await new Promise(r => setTimeout(r, (expectedTime - elapsed) * 1000));
                }
            }
        }

        // Signal completion via data channel
        channel.send(JSON.stringify({ type: 'file-complete' }));
        this.activeTransfer = null;
        this._emit('transferComplete', { targetId, fileName: file.name });
    }

    async _sendViaSocket(targetId, file) {
        const total = file.size;
        const CHUNK_SIZE = 256 * 1024; // 256KB for Socket.io
        let offset = 0;
        let lastUpdate = 0;
        let smoothSpeed = 0;
        const startTime = Date.now();

        this._emit('transferStarted', { targetId, fileName: file.name, total });

        while (offset < total) {
            if (!this.activeTransfer || this.activeTransfer.aborted) {
                this.activeTransfer = null;
                this._emit('transferError', { targetId, error: 'Device disconnected' });
                return;
            }

            const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
            const buffer = await chunkBlob.arrayBuffer();
            this.socket.emit('file-chunk', { targetId, data: buffer });
            offset += buffer.byteLength;

            const now = Date.now();
            if (now - lastUpdate > 500 || offset === total) {
                const elapsed = (now - startTime) / 1000;
                const instantSpeed = elapsed > 0 ? offset / elapsed : 0;
                smoothSpeed = smoothSpeed === 0 ? instantSpeed : (smoothSpeed * 0.7 + instantSpeed * 0.3);

                this._emit('transferProgress', {
                    targetId, sent: offset, total,
                    percent: Math.round((offset / total) * 100),
                    speed: smoothSpeed, fileName: file.name
                });
                lastUpdate = now;
            }

            // Yield + speed limit
            if (performance.now() % 16 < 1) {
                await new Promise(r => setTimeout(r, 0));
            }
            if (this.maxSpeed > 0) {
                const elapsed = (Date.now() - startTime) / 1000;
                const expectedTime = offset / this.maxSpeed;
                if (elapsed < expectedTime) {
                    await new Promise(r => setTimeout(r, (expectedTime - elapsed) * 1000));
                }
            }
        }

        this.socket.emit('file-complete', { targetId });
        this.activeTransfer = null;
        this._emit('transferComplete', { targetId, fileName: file.name });
    }

    // ─────────────────────────────────────────────────────────────
    // RECEIVER LOGIC
    // ─────────────────────────────────────────────────────────────

    acceptFile(senderId, meta) {
        if (!this.incomingRequest || this.incomingRequest.senderId !== senderId) return;

        this.incomingRequest = null;
        this.activeTransfer = {
            senderId, chunks: [], received: 0,
            total: meta?.fileSize || 0, fileName: meta?.fileName || 'file',
            startTime: Date.now()
        };
        this.socket.emit('accept-file', { senderId });
    }

    rejectFile(senderId) {
        this.incomingRequest = null;
        this.socket.emit('reject-file', { senderId });
    }

    _receiveChunk(data) {
        if (!this.activeTransfer) return;
        const expectedSender = this.activeTransfer.senderId;
        if (expectedSender && data.senderId !== expectedSender) return;

        this.activeTransfer.chunks.push(data.data);
        this.activeTransfer.received += data.data.byteLength;

        // Consolidate every 50MB
        const CONSOLIDATE = 50 * 1024 * 1024;
        if (!this.activeTransfer.lastConsolidate) this.activeTransfer.lastConsolidate = 0;
        if (this.activeTransfer.received - this.activeTransfer.lastConsolidate > CONSOLIDATE) {
            const consolidated = new Blob(this.activeTransfer.chunks);
            this.activeTransfer.chunks = [consolidated];
            this.activeTransfer.lastConsolidate = this.activeTransfer.received;
        }

        // Progress
        const now = Date.now();
        if (!this.activeTransfer.lastUpdate || now - this.activeTransfer.lastUpdate > 200) {
            const elapsed = (now - this.activeTransfer.startTime) / 1000;
            const speed = elapsed > 0 ? this.activeTransfer.received / elapsed : 0;
            this._emit('receiveProgress', {
                senderId: data.senderId || this.activeTransfer.senderId,
                percent: Math.round((this.activeTransfer.received / this.activeTransfer.total) * 100),
                speed, fileName: this.activeTransfer.fileName
            });
            this.activeTransfer.lastUpdate = now;
        }
    }

    _finalizeFile(senderId) {
        if (!this.activeTransfer) return;

        const key = `${senderId}-${this.activeTransfer.fileName}`;
        if (this._completedTransfers.has(key)) return;
        this._completedTransfers.add(key);
        setTimeout(() => this._completedTransfers.delete(key), 5000);

        const blob = new Blob(this.activeTransfer.chunks);
        const url = URL.createObjectURL(blob);
        const fileName = this.activeTransfer.fileName;

        this.activeTransfer = null;
        this._emit('fileReceived', { url, senderId, fileName });
    }

    get deviceName() { return this.myDevice?.name || 'Unknown'; }
    get deviceCount() { return this.devices.length; }
    get isBusy() { return !!(this.activeTransfer || this.pendingTransfer || this.incomingRequest); }
}
