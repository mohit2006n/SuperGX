const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    maxHttpBufferSize: 1e8
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Store all connected devices
const devices = new Map(); // socketId -> { id, name, type }

io.on('connection', (socket) => {
    console.log('Device connected:', socket.id);

    // Register device with auto-detected name
    socket.on('register', (deviceInfo) => {
        devices.set(socket.id, {
            id: socket.id,
            name: deviceInfo.name || 'Unknown Device',
            type: deviceInfo.type || 'desktop'
        });
        broadcastDevices();
    });

    // Get current devices
    socket.on('get-devices', () => {
        socket.emit('devices', getDeviceList(socket.id));
    });

    // File transfer via WebSocket relay
    socket.on('send-file-info', (data) => {
        io.to(data.targetId).emit('incoming-file', {
            senderId: socket.id,
            senderName: devices.get(socket.id)?.name || 'Unknown',
            fileName: data.fileName,
            fileSize: data.fileSize,
            fileType: data.fileType
        });
    });

    socket.on('accept-file', (data) => {
        io.to(data.senderId).emit('file-accepted', {
            targetId: socket.id
        });
    });

    socket.on('reject-file', (data) => {
        io.to(data.senderId).emit('file-rejected', {
            targetId: socket.id
        });
    });

    socket.on('file-chunk', (data) => {
        io.to(data.targetId).volatile.emit('file-chunk', {
            senderId: socket.id,
            data: data.data
        });
    });

    socket.on('file-complete', (data) => {
        io.to(data.targetId).emit('file-complete', {
            senderId: socket.id
        });
    });

    socket.on('disconnect', () => {
        console.log('Device disconnected:', socket.id);
        devices.delete(socket.id);
        broadcastDevices();
    });
});

function getDeviceList(excludeId) {
    return Array.from(devices.entries())
        .filter(([id]) => id !== excludeId)
        .map(([id, info]) => ({ id, ...info }));
}

function broadcastDevices() {
    devices.forEach((_, socketId) => {
        io.to(socketId).emit('devices', getDeviceList(socketId));
    });
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`SuperGO running on http://0.0.0.0:${PORT}`);
});
