/**
 * SuperGO Engine - Production Grade
 * All edge cases handled.
 */

class SuperGO {
    constructor(config = {}) {
        this.socket = null;
        this.devices = [];
        this.myDevice = null;
        this.maxSpeed = config.maxSpeed || 0;

        // Transfer State
        this.activeTransfer = null;      // Current sending/receiving transfer
        this.pendingTransfer = null;     // File waiting for acceptance
        this.pendingTargetId = null;     // Who we're waiting on
        this.incomingRequest = null;     // Pending incoming request (for busy check)

        // Deduplication
        this._completedTransfers = new Set();
        this._events = {};
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
        // Allow polling fallback for cloud deployment (Render, Heroku, etc.)
        this.socket = io('/', {
            transports: ['websocket', 'polling'],
            upgrade: true,
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000
        });

        this.socket.on('connect', () => {
            this.socket.emit('register', this.myDevice);
            this._emit('connected', this.myDevice);
        });

        this.socket.on('disconnect', () => {
            // EDGE CASE: Connection lost - cleanup all state
            this._cleanup('Connection lost');
            this._emit('disconnected');
        });

        this.socket.on('devices', (list) => {
            this.devices = list;
            this._emit('devicesUpdated', list);

            // EDGE CASE: Target device disconnected mid-transfer (sender side)
            if (this.activeTransfer?.targetId && !list.some(d => d.id === this.activeTransfer.targetId)) {
                this.activeTransfer.aborted = true;
            }

            // EDGE CASE: Sender disconnected mid-transfer (receiver side)
            if (this.activeTransfer?.senderId && !list.some(d => d.id === this.activeTransfer.senderId)) {
                this._emit('transferError', { senderId: this.activeTransfer.senderId, error: 'Sender disconnected' });
                this.activeTransfer = null;
            }

            // EDGE CASE: Device we're waiting on disconnected
            if (this.pendingTargetId && !list.some(d => d.id === this.pendingTargetId)) {
                this.pendingTransfer = null;
                this.pendingTargetId = null;
                this._emit('transferRejected', { reason: 'Device disconnected' });
            }

            // EDGE CASE: Incoming request sender disconnected
            if (this.incomingRequest && !list.some(d => d.id === this.incomingRequest.senderId)) {
                this.incomingRequest = null;
                this._emit('incomingFileCancelled');
            }
        });

        this.socket.on('incoming-file', (data) => {
            // EDGE CASE: Already busy with a transfer
            if (this.activeTransfer) {
                this.socket.emit('reject-file', { senderId: data.senderId, reason: 'busy' });
                return;
            }
            // EDGE CASE: Already have a pending request (modal open)
            if (this.incomingRequest) {
                this.socket.emit('reject-file', { senderId: data.senderId, reason: 'busy' });
                return;
            }
            this.incomingRequest = data;
            this._emit('incomingFile', data);
        });

        this.socket.on('file-accepted', (data) => {
            if (this.pendingTransfer && this.pendingTargetId === data.targetId) {
                this._sendFileChunks(data.targetId, this.pendingTransfer);
            }
        });

        this.socket.on('file-rejected', (data) => {
            this.pendingTransfer = null;
            this.pendingTargetId = null;
            this._emit('transferRejected', { reason: data?.reason || 'Rejected' });
        });

        this.socket.on('file-chunk', (data) => this._receiveChunk(data));
        this.socket.on('file-complete', (data) => this._finalizeFile(data.senderId));
    }

    disconnect() {
        this._cleanup();
        this.socket?.disconnect();
        this.socket = null;
    }

    _cleanup(reason) {
        if (this.activeTransfer) {
            const id = this.activeTransfer.targetId || this.activeTransfer.senderId;
            if (id && reason) {
                this._emit('transferError', { targetId: id, senderId: id, error: reason });
            }
        }
        this.activeTransfer = null;
        this.pendingTransfer = null;
        this.pendingTargetId = null;
        this.incomingRequest = null;
    }

    // ─────────────────────────────────────────────────────────────
    // SENDER LOGIC
    // ─────────────────────────────────────────────────────────────

    sendFile(targetId, file) {
        // EDGE CASE: Empty file
        if (!file || !file.size) {
            this._emit('transferError', { targetId, error: 'Empty file' });
            return;
        }
        // EDGE CASE: Already transferring
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

    async _sendFileChunks(targetId, file) {
        this.activeTransfer = { targetId, aborted: false, startTime: Date.now() };
        this.pendingTransfer = null;
        this.pendingTargetId = null;

        const total = file.size;
        // 256KB chunks for cloud deployment (reduces latency)
        const CHUNK_SIZE = 256 * 1024;
        let offset = 0;
        let lastYieldTime = performance.now();
        let lastUpdate = 0;
        let smoothSpeed = 0;
        const startTime = Date.now();

        this._emit('transferStarted', { targetId, fileName: file.name, total });

        while (offset < total) {
            // EDGE CASE: Transfer aborted (device disconnected)
            if (!this.activeTransfer || this.activeTransfer.aborted) {
                this.activeTransfer = null;
                this._emit('transferError', { targetId, error: 'Device disconnected' });
                return;
            }

            const chunkBlob = file.slice(offset, offset + CHUNK_SIZE);
            const buffer = await chunkBlob.arrayBuffer();

            this.socket.emit('file-chunk', { targetId, data: buffer });
            offset += buffer.byteLength;

            // Progress (Throttled)
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

            // Yield to event loop
            if (performance.now() - lastYieldTime > 16) {
                await new Promise(r => setTimeout(r, 0));
                lastYieldTime = performance.now();
            }

            // Speed Limit
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
        // EDGE CASE: No pending request (stale click)
        if (!this.incomingRequest || this.incomingRequest.senderId !== senderId) {
            return;
        }
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
        // EDGE CASE: Chunk for wrong/no transfer
        if (!this.activeTransfer || this.activeTransfer.senderId !== data.senderId) return;

        this.activeTransfer.chunks.push(data.data);
        this.activeTransfer.received += data.data.byteLength;

        // MEMORY OPTIMIZATION: Consolidate chunks every 50MB to prevent crash
        const CONSOLIDATE_THRESHOLD = 50 * 1024 * 1024; // 50MB
        if (!this.activeTransfer.lastConsolidate) this.activeTransfer.lastConsolidate = 0;

        if (this.activeTransfer.received - this.activeTransfer.lastConsolidate > CONSOLIDATE_THRESHOLD) {
            // Merge all chunks into a single Blob, then store as one "chunk"
            const consolidated = new Blob(this.activeTransfer.chunks);
            this.activeTransfer.chunks = [consolidated]; // Replace array with single Blob
            this.activeTransfer.lastConsolidate = this.activeTransfer.received;
        }

        // Progress (Throttled)
        const now = Date.now();
        if (!this.activeTransfer.lastUpdate || now - this.activeTransfer.lastUpdate > 500) {
            const elapsed = (now - this.activeTransfer.startTime) / 1000;
            const speed = elapsed > 0 ? this.activeTransfer.received / elapsed : 0;
            this._emit('receiveProgress', {
                senderId: data.senderId,
                percent: Math.round((this.activeTransfer.received / this.activeTransfer.total) * 100),
                speed, fileName: this.activeTransfer.fileName
            });
            this.activeTransfer.lastUpdate = now;
        }
    }

    _finalizeFile(senderId) {
        // EDGE CASE: Finalize for wrong/no transfer
        if (!this.activeTransfer || this.activeTransfer.senderId !== senderId) return;

        // EDGE CASE: Duplicate file-complete event
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
