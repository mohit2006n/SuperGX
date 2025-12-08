/**
 * SuperGO - P2P File Transfer Engine
 * A modular, event-driven WebRTC file sharing library.
 * 
 * @example
 * const engine = new SuperGO();
 * engine.on('ready', (roomId) => console.log('Room ready:', roomId));
 * engine.on('filesAvailable', (files) => console.log('Files:', files));
 * engine.createRoom('Alice');
 * 
 * @fires SuperGO#ready
 * @fires SuperGO#peerJoined
 * @fires SuperGO#peerLeft
 * @fires SuperGO#filesAvailable
 * @fires SuperGO#progress
 * @fires SuperGO#complete
 * @fires SuperGO#error
 */
class SuperGO {
    /**
     * Create a SuperGO instance
     * @param {Object} [options] - Configuration options
     * @param {string} [options.signalServer='/'] - Socket.IO server URL
     * @param {number} [options.peerPort=9000] - PeerJS server port
     * @param {number} [options.chunkSize=65536] - Transfer chunk size (64KB default)
     */
    constructor(options = {}) {
        this.config = {
            signalServer: options.signalServer || '/',
            peerPort: options.peerPort || 9000,
            // 256KB chunks - good balance for most connections
            chunkSize: options.chunkSize || 256 * 1024,
            // Buffer limit before backpressure (32MB)
            maxBufferedAmount: options.maxBufferedAmount || 32 * 1024 * 1024
        };

        this.state = {
            peer: null,
            socket: null,
            roomId: null,
            userName: 'Anonymous',
            isHost: false,
            files: [],
            connections: new Map(),
            participants: new Map(),
            peerFiles: new Map(),
            transfers: new Map(),
            cancelledIndices: new Set()
        };

        this._events = {};
    }

    // ─────────────────────────────────────────────────────────────
    // EVENT SYSTEM
    // ─────────────────────────────────────────────────────────────

    /**
     * Subscribe to an event
     * @param {string} event - Event name
     * @param {Function} callback - Handler function
     */
    on(event, callback) {
        if (!this._events[event]) this._events[event] = [];
        this._events[event].push(callback);
    }

    /**
     * Unsubscribe from an event
     * @param {string} event - Event name
     * @param {Function} [callback] - Specific handler to remove (removes all if omitted)
     */
    off(event, callback) {
        if (!this._events[event]) return;
        if (!callback) {
            delete this._events[event];
        } else {
            this._events[event] = this._events[event].filter(cb => cb !== callback);
        }
    }

    /** @private */
    _emit(event, data) {
        if (this._events[event]) {
            this._events[event].forEach(cb => cb(data));
        }
    }

    // ─────────────────────────────────────────────────────────────
    // ROOM MANAGEMENT
    // ─────────────────────────────────────────────────────────────

    /**
     * Create a new room and become the host
     * @param {string} userName - Display name
     * @param {Object} [options] - Room options
     * @param {string} [options.access='public'] - 'public' or 'private'
     * @returns {string} The generated room ID
     * 
     * @fires SuperGO#ready
     */
    createRoom(userName, options = {}) {
        const roomId = this._generateRoomId();
        const access = options.access || 'public';

        this.state.roomId = roomId;
        this.state.userName = userName || 'Anonymous';
        this.state.isHost = true;
        this.state.access = access;

        this._initPeer(roomId);
        this._initSocket();

        return roomId;
    }

    /**
     * Join an existing room
     * @param {string} roomId - Room code to join
     * @param {string} userName - Display name
     * 
     * @fires SuperGO#ready
     * @fires SuperGO#error
     */
    joinRoom(roomId, userName) {
        if (!roomId || roomId.length < 4) {
            this._emit('error', 'Invalid room code');
            return;
        }

        this.state.roomId = roomId.toUpperCase();
        this.state.userName = userName || 'Anonymous';
        this.state.isHost = false;

        this._initPeer();
        this._initSocket();
    }

    /**
     * Leave the current room and cleanup
     */
    leaveRoom() {
        // Cancel all active transfers
        this.state.transfers.forEach((transfer, key) => {
            if (transfer.abort) transfer.abort();
        });
        this.state.transfers.clear();

        // Close connections
        this.state.connections.forEach(conn => conn.close());
        this.state.connections.clear();

        // Destroy peer
        if (this.state.peer) {
            this.state.peer.destroy();
            this.state.peer = null;
        }

        // Disconnect socket
        if (this.state.socket) {
            this.state.socket.disconnect();
            this.state.socket = null;
        }

        // Reset state
        this.state.roomId = null;
        this.state.files = [];
        this.state.participants.clear();
        this.state.peerFiles.clear();
    }

    /**
     * Discover available public rooms
     * @fires SuperGO#roomsUpdated
     */
    discoverRooms() {
        if (!this.state.socket) {
            this._initSocket();
        }

        const tryEmit = () => {
            if (this.state.socket && this.state.socket.connected) {
                this.state.socket.emit('get-active-sessions');
            } else {
                setTimeout(tryEmit, 100);
            }
        };
        tryEmit();
    }

    // ─────────────────────────────────────────────────────────────
    // FILE MANAGEMENT
    // ─────────────────────────────────────────────────────────────

    /**
     * Add files to share (auto-shares immediately)
     * @param {FileList|File[]} fileList - Files to share
     * 
     * @fires SuperGO#filesAvailable
     */
    addFiles(fileList) {
        const newFiles = Array.from(fileList).map((f, i) => ({
            file: f,
            name: f.name,
            size: f.size,
            type: f.type,
            index: this.state.files.length + i
        }));

        this.state.files = [...this.state.files, ...newFiles];
        this._broadcastFileList();
        this._emitFilesAvailable();
    }

    /**
     * Remove files from sharing
     * @param {number[]} indices - File indices to remove
     */
    removeFiles(indices) {
        const indexSet = new Set(indices);

        // Cancel any active transfers for these files
        indices.forEach(index => this._cancelUpload(index));

        // Remove from files array
        this.state.files = this.state.files.filter(f => !indexSet.has(f.index));

        this._broadcastFileList();
        this._emitFilesAvailable();
    }

    /**
     * Download files from peers
     * @param {Array<{peerId: string, fileIndex: number}>} requests - Files to download
     * 
     * @fires SuperGO#progress
     * @fires SuperGO#complete
     */
    downloadFiles(requests) {
        if (!requests || requests.length === 0) return;

        // Clear cancelled state
        this.state.cancelledIndices.clear();

        // Check if Socket.IO is using WebSocket (fast) or polling (slow)
        // WebSocket = use high-speed relay through server
        // Polling = use WebRTC P2P (polling has body size limits)
        const transport = this.state.socket?.io?.engine?.transport?.name;
        const useWebSocketRelay = transport === 'websocket';

        if (useWebSocketRelay) {
            // High-speed WebSocket mode - goes through server
            requests.forEach(r => {
                this._requestFileViaWS(r.peerId, r.fileIndex);
            });
        } else {
            // WebRTC P2P mode - direct peer connection (fallback)
            const byPeer = new Map();
            requests.forEach(r => {
                if (!byPeer.has(r.peerId)) byPeer.set(r.peerId, []);
                byPeer.get(r.peerId).push(r.fileIndex);
            });

            byPeer.forEach((indices, peerId) => {
                const conn = this.state.connections.get(peerId);
                if (conn && conn.open) {
                    conn.send({ type: 'request-files', fileIndices: indices });
                }
            });
        }
    }

    /**
     * Cancel an active download
     * @param {number} fileIndex - File index
     * @param {string} peerId - Peer ID
     */
    cancelDownload(fileIndex, peerId) {
        const transferKey = `${peerId}:${fileIndex}`;
        const transfer = this.state.transfers.get(transferKey);

        if (transfer) {
            transfer.cancelled = true;
            if (transfer.abort) transfer.abort();
            this.state.transfers.delete(transferKey);
        }

        this.state.cancelledIndices.add(transferKey);
        setTimeout(() => this.state.cancelledIndices.delete(transferKey), 30000);

        // Notify peer
        const conn = this.state.connections.get(peerId);
        if (conn && conn.open) {
            conn.send({ type: 'cancel-transfer', fileIndex });
        }

        this._emit('transferCancelled', { fileIndex, peerId });
    }

    // ─────────────────────────────────────────────────────────────
    // GETTERS
    // ─────────────────────────────────────────────────────────────

    /** @returns {string|null} Current room ID */
    get roomId() { return this.state.roomId; }

    /** @returns {boolean} Whether this instance is the room host */
    get isHost() { return this.state.isHost; }

    /** @returns {number} Number of connected peers */
    get peerCount() { return this.state.connections.size; }

    /** @returns {Array} List of participants */
    get participants() {
        return Array.from(this.state.participants.entries()).map(([id, p]) => ({
            id,
            name: p.name,
            isHost: p.isHost
        }));
    }

    // ─────────────────────────────────────────────────────────────
    // PRIVATE: INITIALIZATION
    // ─────────────────────────────────────────────────────────────

    /** @private */
    _generateRoomId() {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    /** @private */
    _initPeer(peerId = undefined) {
        if (this.state.peer) return;

        const port = window.location.port === '' ?
            (window.location.protocol === 'https:' ? 443 : 80) :
            parseInt(window.location.port);

        this.state.peer = new Peer(peerId, {
            host: window.location.hostname,
            port: port,
            path: '/peerjs',
            debug: 0,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' }
                ],
                sdpSemantics: 'unified-plan'
            }
        });

        this._setupPeerEvents();
    }

    /** @private */
    _initSocket() {
        if (this.state.socket) return;

        // Try WebSocket first (fast), fall back to polling if needed
        // This works on: localhost, production hosts (Vercel, Railway, etc)
        // Falls back on: devtunnels, some corporate proxies
        this.state.socket = io(this.config.signalServer, {
            transports: ['websocket', 'polling'],
            upgrade: true,
            rememberUpgrade: true
        });

        this._setupSocketEvents();
    }

    /** @private */
    _setupPeerEvents() {
        this.state.peer.on('open', (id) => {
            this.state.myPeerId = id;

            if (this.state.socket && this.state.socket.connected) {
                this._registerWithServer();
            }

            this._emit('ready', this.state.roomId);
        });

        this.state.peer.on('connection', (conn) => {
            this._handleConnection(conn);
        });

        this.state.peer.on('error', (err) => {
            let msg = 'Connection error';
            if (err.type === 'peer-unavailable') msg = 'Room not found or host disconnected';
            if (err.type === 'unavailable-id') msg = 'Room code already in use';
            if (err.type === 'network' || err.type === 'server-error') {
                msg = 'Network error, retrying...';
                setTimeout(() => {
                    if (this.state.peer && !this.state.peer.destroyed) {
                        this.state.peer.reconnect();
                    }
                }, 2000);
            }
            this._emit('error', msg);
        });

        this.state.peer.on('disconnected', () => {
            if (this.state.peer) this.state.peer.reconnect();
        });
    }

    /** @private */
    _setupSocketEvents() {
        this.state.socket.on('connect', () => {
            if (this.state.peer && this.state.peer.id) {
                this._registerWithServer();
            }
        });

        this.state.socket.on('disconnect', () => {
            this._emit('disconnected');
        });

        this.state.socket.on('connect_error', () => {
            this._emit('error', 'Signaling server unavailable');
        });

        this.state.socket.on('host-info', (hostPeerId) => {
            if (!this.state.isHost) {
                const conn = this.state.peer.connect(hostPeerId, {
                    reliable: true,
                    serialization: 'binary',
                    ordered: false
                });
                this._handleConnection(conn);
            }
        });

        this.state.socket.on('session-error', (msg) => {
            this._emit('error', msg);
        });

        this.state.socket.on('active-sessions', (sessions) => {
            this._emit('roomsUpdated', sessions);
        });

        // ═══════════════════════════════════════════════════════════════
        // WEBSOCKET TRANSFER HANDLERS (Maximum Speed Mode)
        // ═══════════════════════════════════════════════════════════════

        // Receive file list from other peers via WebSocket
        this.state.socket.on('ws-file-list', (data) => {
            this.state.peerFiles.set(data.senderId, data.files.map((f, i) => ({
                ...f,
                peerId: data.senderId,
                index: i
            })));
            this._emitFilesAvailable();
        });

        // Handle file request (sender side)
        this.state.socket.on('ws-request-file', (data) => {
            const file = this.state.files.find(f => f.index === data.fileIndex);
            if (file) {
                this._sendFileViaWS(data.requesterId, file);
            }
        });

        // Receive chunks via WebSocket (receiver side)
        this.state.socket.on('ws-chunk', (data) => {
            this._receiveWSChunk(data.senderId, data.fileIndex, data.data);
        });

        // File transfer complete
        this.state.socket.on('ws-file-end', (data) => {
            this._finalizeWSFile(data.senderId, data.fileIndex);
        });
    }

    /** @private */
    _registerWithServer() {
        if (this.state.isHost) {
            this.state.socket.emit('create-session', {
                id: this.state.peer.id,
                access: this.state.access || 'public',
                hostName: this.state.userName
            });
        } else {
            this.state.socket.emit('join-session', this.state.roomId);
        }
    }

    // ─────────────────────────────────────────────────────────────
    // PRIVATE: CONNECTION HANDLING
    // ─────────────────────────────────────────────────────────────

    /** @private */
    _handleConnection(conn) {
        conn.on('open', () => {
            this.state.connections.set(conn.peer, conn);

            // Send identity
            conn.send({
                type: 'info',
                name: this.state.userName,
                isHost: this.state.isHost
            });

            // Send file list
            this._broadcastFileList();

            this._emit('connected', { peerId: conn.peer });
        });

        conn.on('data', (data) => this._handleData(conn, data));

        conn.on('close', () => {
            const participant = this.state.participants.get(conn.peer);
            this.state.connections.delete(conn.peer);
            this.state.participants.delete(conn.peer);
            this.state.peerFiles.delete(conn.peer);

            this._broadcastParticipantList();
            this._emitFilesAvailable();

            if (participant) {
                this._emit('peerLeft', { peerId: conn.peer, name: participant.name });
            }
        });
    }

    /** @private */
    _handleData(conn, data) {
        switch (data.type) {
            case 'info':
                this.state.participants.set(conn.peer, {
                    name: data.name,
                    isHost: data.isHost
                });
                this._broadcastParticipantList();
                this._emit('peerJoined', { peerId: conn.peer, name: data.name });
                break;

            case 'participant-list':
                const myId = this.state.peer.id;
                const list = data.participants.map(p => ({
                    ...p,
                    isSelf: p.id === myId
                }));
                this._emit('participantsUpdated', list);
                break;

            case 'file-list':
                this.state.peerFiles.set(conn.peer, data.files);
                this._emitFilesAvailable();
                break;

            case 'request-files':
                this._startSending(conn, data.fileIndices);
                break;

            case 'chunk':
                this._receiveChunk(conn.peer, data);
                break;

            case 'file-end':
                this._finalizeFile(conn.peer, data.fileIndex);
                break;

            case 'cancel-transfer':
                this._handleCancelFromPeer(conn.peer, data.fileIndex);
                break;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // PRIVATE: FILE BROADCASTING
    // ─────────────────────────────────────────────────────────────

    /** @private */
    _broadcastFileList() {
        const fileList = this.state.files.map(f => ({
            name: f.name,
            size: f.size,
            index: f.index,
            type: f.type,
            senderName: this.state.userName
        }));

        // Broadcast via WebRTC (works everywhere)
        this.state.connections.forEach(conn => {
            if (conn.open) {
                conn.send({ type: 'file-list', files: fileList });
            }
        });

        // Also broadcast via WebSocket if using WebSocket transport
        const transport = this.state.socket?.io?.engine?.transport?.name;
        if (transport === 'websocket') {
            this._broadcastFileListViaWS();
        }
    }

    /** @private */
    _broadcastParticipantList() {
        // Build list of all connected participants (excluding self)
        const otherParticipants = Array.from(this.state.participants.entries()).map(([id, p]) => ({
            id,
            name: p.name,
            isHost: p.isHost
        }));

        // Local UI: emit list with self included
        this._emit('participantsUpdated', [
            { id: this.state.myPeerId, name: this.state.userName, isHost: this.state.isHost, isSelf: true },
            ...otherParticipants
        ]);

        // If host, also send the full list to all peers (including host info)
        if (this.state.isHost) {
            const fullListForPeers = [
                { id: this.state.myPeerId, name: this.state.userName, isHost: true },
                ...otherParticipants
            ];
            this.state.connections.forEach(conn => {
                if (conn.open) {
                    conn.send({ type: 'participant-list', participants: fullListForPeers });
                }
            });
        }
    }

    /** @private */
    _emitFilesAvailable() {
        const files = [];

        // My files
        this.state.files.forEach(f => {
            files.push({
                ...f,
                isLocal: true,
                peerId: this.state.myPeerId,
                senderName: this.state.userName
            });
        });

        // Peer files
        this.state.peerFiles.forEach((peerFiles, peerId) => {
            const participant = this.state.participants.get(peerId);
            peerFiles.forEach(f => {
                files.push({
                    ...f,
                    isLocal: false,
                    peerId,
                    senderName: participant ? participant.name : f.senderName || 'Unknown'
                });
            });
        });

        this._emit('filesAvailable', files);
    }

    // ─────────────────────────────────────────────────────────────
    // PRIVATE: FILE TRANSFER (SENDING)
    // ─────────────────────────────────────────────────────────────

    /** @private */
    async _startSending(conn, fileIndices) {
        const filesToSend = fileIndices
            ? this.state.files.filter(f => fileIndices.includes(f.index))
            : this.state.files;

        for (const fileObj of filesToSend) {
            await this._sendFile(conn, fileObj);
        }
    }

    /** @private */
    async _sendFile(conn, fileObj) {
        const file = fileObj.file;
        const chunkSize = this.config.chunkSize;
        const transferKey = `upload:${conn.peer}:${fileObj.index}`;

        this.state.transfers.set(transferKey, {
            startTime: Date.now(),
            lastUpdate: Date.now(),
            bytesSent: 0,
            total: file.size,
            cancelled: false
        });

        // Handle empty files
        if (file.size === 0) {
            conn.send({ type: 'file-end', fileIndex: fileObj.index });
            return;
        }

        const dc = conn.dataChannel;
        let offset = 0;
        let nextBuffer = null;
        let nextBufferPromise = null;

        // Pre-read first chunk
        const readChunk = (start) => {
            if (start >= file.size) return Promise.resolve(null);
            return file.slice(start, Math.min(start + chunkSize, file.size)).arrayBuffer();
        };

        // Start pre-loading first chunk
        nextBufferPromise = readChunk(0);

        while (offset < file.size) {
            const transfer = this.state.transfers.get(transferKey);
            if (!transfer || transfer.cancelled || !conn.open) break;

            // Wait for the pre-loaded chunk
            const buffer = await nextBufferPromise;
            if (!buffer) break;

            // Immediately start loading next chunk (pipelining)
            const nextOffset = offset + buffer.byteLength;
            nextBufferPromise = readChunk(nextOffset);

            // Simple backpressure - only wait if really saturated
            while (dc.bufferedAmount > this.config.maxBufferedAmount && conn.open) {
                await new Promise(r => setTimeout(r, 0));
            }

            // Send current chunk
            conn.send({
                type: 'chunk',
                fileIndex: fileObj.index,
                data: buffer
            });

            offset = nextOffset;
            transfer.bytesSent = offset;

            // Update progress every 2MB for smoother display
            if (offset % (2 * 1024 * 1024) < chunkSize) {
                this._emitProgress(transferKey, offset, file.size, null, fileObj.index);
            }
        }

        // Final progress update
        this._emitProgress(transferKey, file.size, file.size, null, fileObj.index);

        if (conn.open) {
            conn.send({ type: 'file-end', fileIndex: fileObj.index });
        }

        this.state.transfers.delete(transferKey);
    }

    /** @private */
    _cancelUpload(fileIndex) {
        for (const [key, transfer] of this.state.transfers) {
            if (key.startsWith('upload:') && key.endsWith(`:${fileIndex}`)) {
                transfer.cancelled = true;
                this.state.transfers.delete(key);

                const parts = key.split(':');
                const peerId = parts[1];
                const conn = this.state.connections.get(peerId);
                if (conn && conn.open) {
                    conn.send({ type: 'cancel-transfer', fileIndex });
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // PRIVATE: FILE TRANSFER (RECEIVING)
    // ─────────────────────────────────────────────────────────────

    /** @private */
    async _receiveChunk(peerId, data) {
        const transferKey = `${peerId}:${data.fileIndex}`;

        if (this.state.cancelledIndices.has(transferKey)) return;

        let transfer = this.state.transfers.get(transferKey);

        if (!transfer) {
            const files = this.state.peerFiles.get(peerId);
            const fileMeta = files?.find(f => f.index === data.fileIndex);
            if (!fileMeta) return;

            transfer = this._initDownload(fileMeta);
            this.state.transfers.set(transferKey, transfer);
            this._emit('downloadStarted', fileMeta);
        }

        transfer.chunks.push(new Uint8Array(data.data));
        transfer.bytesReceived += data.data.byteLength;

        this._emitProgress(transferKey, transfer.bytesReceived, transfer.total, peerId, data.fileIndex);
    }

    /** @private */
    _initDownload(fileMeta) {
        return {
            startTime: Date.now(),
            lastUpdate: Date.now(),
            bytesReceived: 0,
            total: fileMeta.size,
            name: fileMeta.name,
            chunks: [],
            cancelled: false,
            abort: function () { this.chunks = []; }
        };
    }

    /** @private */
    async _finalizeFile(peerId, fileIndex) {
        const transferKey = `${peerId}:${fileIndex}`;
        const transfer = this.state.transfers.get(transferKey);

        if (transfer && transfer.chunks.length > 0) {
            const blob = new Blob(transfer.chunks, { type: 'application/octet-stream' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = transfer.name;
            a.click();

            setTimeout(() => URL.revokeObjectURL(url), 30000);

            this._emit('complete', { fileIndex, peerId, name: transfer.name });
        }

        this.state.transfers.delete(transferKey);
    }

    /** @private */
    _handleCancelFromPeer(peerId, fileIndex) {
        const transferKey = `${peerId}:${fileIndex}`;
        const transfer = this.state.transfers.get(transferKey);

        if (transfer) {
            transfer.cancelled = true;
            transfer.chunks = [];
            this.state.transfers.delete(transferKey);
            this._emit('transferCancelled', { fileIndex, peerId });
        }
    }

    // ─────────────────────────────────────────────────────────────
    // PRIVATE: PROGRESS TRACKING
    // ─────────────────────────────────────────────────────────────

    /** @private */
    _emitProgress(transferKey, processed, total, peerId, fileIndex) {
        const transfer = this.state.transfers.get(transferKey);
        if (!transfer) return;

        const now = Date.now();
        const elapsed = (now - transfer.lastUpdate) / 1000;

        // Update every 200ms for smoother display
        if (elapsed >= 0.2) {
            // Use OVERALL average speed for consistency (total bytes / total time)
            const totalElapsed = (now - transfer.startTime) / 1000;
            const overallSpeed = totalElapsed > 0 ? processed / totalElapsed : 0;

            // Smooth speed with exponential moving average
            if (!transfer.smoothSpeed) transfer.smoothSpeed = overallSpeed;
            transfer.smoothSpeed = transfer.smoothSpeed * 0.7 + overallSpeed * 0.3;

            const percent = Math.min(100, Math.round((processed / total) * 100));
            const remaining = total - processed;
            const eta = transfer.smoothSpeed > 0 ? Math.ceil(remaining / transfer.smoothSpeed) : 0;

            this._emit('progress', {
                fileIndex,
                peerId,
                percent,
                speed: transfer.smoothSpeed,
                eta,
                received: processed,
                total
            });

            transfer.lastUpdate = now;
        }
    }

    // ─────────────────────────────────────────────────────────────
    // WEBSOCKET TRANSFER (Maximum Speed - No RTCDataChannel Limits)
    // ─────────────────────────────────────────────────────────────

    /** @private - Broadcast file list via WebSocket for high-speed mode */
    _broadcastFileListViaWS() {
        if (!this.state.socket) return;

        const fileList = this.state.files.map(f => ({
            name: f.name,
            size: f.size,
            index: f.index,
            type: f.type,
            senderName: this.state.userName
        }));

        this.state.socket.emit('ws-file-list', { files: fileList });
    }

    /** @private - Send file via WebSocket (high-speed mode) */
    async _sendFileViaWS(targetId, fileObj) {
        const file = fileObj.file;
        const chunkSize = 512 * 1024; // 512KB chunks for WebSocket
        const transferKey = `ws-upload:${targetId}:${fileObj.index}`;

        this.state.transfers.set(transferKey, {
            startTime: Date.now(),
            lastUpdate: Date.now(),
            bytesSent: 0,
            total: file.size
        });

        let offset = 0;

        while (offset < file.size) {
            const transfer = this.state.transfers.get(transferKey);
            if (!transfer) break;

            const end = Math.min(offset + chunkSize, file.size);
            const chunk = file.slice(offset, end);
            const buffer = await chunk.arrayBuffer();

            this.state.socket.emit('ws-chunk', {
                targetId,
                fileIndex: fileObj.index,
                data: buffer
            });

            offset += buffer.byteLength;
            transfer.bytesSent = offset;

            // Emit progress every 1MB
            if (offset % (1024 * 1024) < chunkSize) {
                this._emitProgress(transferKey, offset, file.size, targetId, fileObj.index);
            }

            // Small yield to prevent blocking
            if (offset % (5 * 1024 * 1024) < chunkSize) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        this.state.socket.emit('ws-file-end', {
            targetId,
            fileIndex: fileObj.index
        });

        this.state.transfers.delete(transferKey);
    }

    /** @private - Receive chunk via WebSocket */
    _receiveWSChunk(senderId, fileIndex, data) {
        const transferKey = `ws:${senderId}:${fileIndex}`;
        let transfer = this.state.transfers.get(transferKey);

        if (!transfer) {
            // Get file info from peer files
            const peerFileList = this.state.peerFiles.get(senderId);
            const fileInfo = peerFileList ? peerFileList.find(f => f.index === fileIndex) : null;

            transfer = {
                startTime: Date.now(),
                lastUpdate: Date.now(),
                chunks: [],
                received: 0,
                total: fileInfo ? fileInfo.size : 0,
                name: fileInfo ? fileInfo.name : 'unknown',
                type: fileInfo ? fileInfo.type : 'application/octet-stream'
            };
            this.state.transfers.set(transferKey, transfer);
        }

        transfer.chunks.push(new Uint8Array(data));
        transfer.received += data.byteLength;

        this._emitProgress(transferKey, transfer.received, transfer.total, senderId, fileIndex);
    }

    /** @private - Finalize WebSocket file transfer */
    _finalizeWSFile(senderId, fileIndex) {
        const transferKey = `ws:${senderId}:${fileIndex}`;
        const transfer = this.state.transfers.get(transferKey);

        if (transfer && transfer.chunks.length > 0) {
            const blob = new Blob(transfer.chunks, { type: transfer.type || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = transfer.name;
            a.click();

            setTimeout(() => URL.revokeObjectURL(url), 30000);

            this._emit('complete', { fileIndex, peerId: senderId, name: transfer.name });
        }

        this.state.transfers.delete(transferKey);
    }

    /** @private - Request file via WebSocket (high-speed mode) */
    _requestFileViaWS(senderId, fileIndex) {
        this.state.socket.emit('ws-request-file', {
            senderId,
            fileIndex
        });
    }
}

// Export for module usage, but also make available globally for script tag usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SuperGO;
}

