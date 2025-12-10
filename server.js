const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});

app.use(express.static('public'));

const ids = {};

io.on('connection', (socket) => {
    // Session Management
    socket.on('create-id', (data) => {
        const { id } = data;
        if (ids[id]) {
            socket.emit('id-exists', id);
        } else {
            ids[id] = { senderId: socket.id };
            socket.shareId = id;
            socket.isSender = true;
            socket.join(id);
            socket.emit('id-created', id);
        }
    });

    socket.on('join-id', (id) => {
        const session = ids[id];
        if (session) {
            socket.join(id);
            socket.joinedRoom = id;
            socket.emit('sender-info', { senderId: session.senderId });
            // Notify sender that a peer joined (for UI count)
            io.to(session.senderId).emit('peer-joined', { peerId: socket.id });
        } else {
            socket.emit('id-not-found', id);
        }
    });

    socket.on('disconnect', () => {
        if (socket.isSender && socket.shareId && ids[socket.shareId]) {
            io.to(socket.shareId).emit('peer-disconnected', { message: 'Host disconnected' });
            delete ids[socket.shareId];
        } else if (socket.joinedRoom) {
            // Notify Host that a peer left
            io.to(socket.joinedRoom).emit('peer-disconnected', { peerId: socket.id });
        }
    });

    // Signaling (Direct P2P routing)
    const route = (ev, data) => io.to(data.targetId).emit(ev, { ...data, senderId: socket.id });

    // WebRTC
    socket.on('rtc-offer', d => route('rtc-offer', d));
    socket.on('rtc-answer', d => route('rtc-answer', d));
    socket.on('rtc-ice-candidate', d => route('rtc-ice-candidate', d));

    // File Transfer Handshake
    socket.on('send-file-info', d => route('incoming-file', d));
    socket.on('accept-file', d => route('file-accepted', d));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Supr running on http://0.0.0.0:${PORT}`));
