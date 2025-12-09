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

io.on('connection', (socket) => {
    // Room Management
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        // Notify host (and others) that a new peer joined
        socket.to(roomId).emit('peer-joined', { peerId: socket.id });
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
    socket.on('reject-file', d => route('file-rejected', d));

    // Relay Data (Fallback)
    socket.on('file-chunk', d => route('file-chunk', d));
    socket.on('file-complete', d => route('file-complete', d));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Supr running on http://0.0.0.0:${PORT}`));
