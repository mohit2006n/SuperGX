const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');

const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
    pingTimeout: 1800000,
    pingInterval: 60000,
    maxHttpBufferSize: 500 * 1024 * 1024, // 500MB max for file chunks
    transports: ['websocket', 'polling'],
    allowEIO3: true,
});

// Main App (Socket.io + Static Files)
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.use(express.static(path.join(__dirname, 'public')));

// PeerJS Server - Attached to main server
const peerServerInstance = ExpressPeerServer(server, {
    debug: true,
    path: '/peerjs'
});

app.use(peerServerInstance);

const sessions = {};
const roomMembers = {};

io.on('connection', (socket) => {
    socket.on('create-session', (data) => {
        const id = typeof data === 'object' ? data.id : data;
        const access = typeof data === 'object' ? data.access : 'public';
        const hostName = typeof data === 'object' ? data.hostName : 'Anonymous';

        sessions[id] = { peerId: id, socketId: socket.id, access, hostName };
        socket.join(id);
        socket.roomId = id;

        if (!roomMembers[id]) roomMembers[id] = new Set();
        roomMembers[id].add(socket.id);

        socket.emit('session-created', id);
        broadcastSessions();
    });

    socket.on('join-session', (id) => {
        const session = sessions[id];
        if (session) {
            socket.join(id);
            socket.roomId = id;

            if (!roomMembers[id]) roomMembers[id] = new Set();
            roomMembers[id].add(socket.id);

            socket.emit('host-info', session.peerId);
        } else {
            socket.emit('session-error', 'Session not found');
        }
    });

    socket.on('get-active-sessions', () => {
        broadcastSessions(socket);
    });

    // ═══════════════════════════════════════════════════════════════
    // WEBSOCKET FILE RELAY - Maximum Speed Mode
    // ═══════════════════════════════════════════════════════════════

    socket.on('ws-file-list', (data) => {
        if (socket.roomId) {
            socket.to(socket.roomId).emit('ws-file-list', {
                senderId: socket.id,
                files: data.files
            });
        }
    });

    socket.on('ws-request-file', (data) => {
        if (socket.roomId) {
            io.to(data.senderId).emit('ws-request-file', {
                requesterId: socket.id,
                fileIndex: data.fileIndex
            });
        }
    });

    // High-speed chunk relay
    socket.on('ws-chunk', (data) => {
        io.to(data.targetId).volatile.emit('ws-chunk', {
            senderId: socket.id,
            fileIndex: data.fileIndex,
            data: data.data
        });
    });

    socket.on('ws-file-end', (data) => {
        io.to(data.targetId).emit('ws-file-end', {
            senderId: socket.id,
            fileIndex: data.fileIndex
        });
    });

    // ═══════════════════════════════════════════════════════════════

    socket.on('disconnect', () => {
        if (socket.roomId && roomMembers[socket.roomId]) {
            roomMembers[socket.roomId].delete(socket.id);
            if (roomMembers[socket.roomId].size === 0) {
                delete roomMembers[socket.roomId];
            }
        }

        for (const id in sessions) {
            if (sessions[id].socketId === socket.id) {
                io.to(id).emit('peer-disconnected');
                delete sessions[id];
                broadcastSessions();
                break;
            }
        }
    });

    const broadcastSessions = (targetSocket = io) => {
        const activeSessions = Object.values(sessions).map(s => ({
            id: s.access === 'public' ? s.peerId : null,
            hostName: s.hostName,
            access: s.access,
            isSecure: s.access === 'private'
        }));
        targetSocket.emit('active-sessions', activeSessions);
    };
});

server.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(`WebSocket transfer mode enabled (max speed)`);
});
