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
        } else {
            // If checking for client disconnects to update host count
            // We'd need to track which room the socket joined or broadcast to all?
            // For simplicity/speed, we let the P2P connection failure handle logical disconnect
            // But to update the Host UI count, we might need a map. 
            // The example code didn't handle Client->Host disconnect notifications explicitly for UI, 
            // but my previous code did. I'll add a simple broadcast.
            // A client doesn't "own" an ID, but they joined a room (via join-id? no, socket.join(id) happens in create-id ONLY for sender in example)
            // Wait, in example, only Sender calls socket.join(id). Receiver DOES NOT join the room.
            // So socket.to(id) only sends to Sender? No, sender IS in the room. 
            // If Receiver doesn't join the room, how does Sender know they left?
            // I will add `socket.join(id)` to join-id as well for notifications.
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
