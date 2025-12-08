# SuperGO 🚀

**SuperGO** is a blazing fast, secure, and private peer-to-peer (P2P) file sharing application. It allows you to share files of any size directly between devices without storing them on any server.

![SuperGO UI](public/screenshot.png) *Add a screenshot here if available*

## ✨ Features

*   **🔒 End-to-End Encrypted**: All transfers are secured using **DTLS 1.3** (Datagram Transport Layer Security) via WebRTC. Your files never touch our servers.
*   **⚡ Blazing Fast**: Direct P2P connections ensure maximum transfer speeds, limited only by your network.
*   **🌍 Public & Private Rooms**:
    *   **Public Rooms**: Visible to everyone, easy to join.
    *   **Private Rooms**: Secured with a Lock icon. Requires a 6-digit code to join.
*   **📂 Multi-File & Folder Support**: Drag and drop entire folders or select multiple files at once.
*   **👥 Multi-Peer Support**: Share files with multiple people simultaneously in the same room.
*   **📱 Responsive Design**: A beautiful, full-screen dark mode UI that works on desktop and mobile.
*   **🧩 Modular Architecture**: Built on the robust `SuperGO` engine, separating core logic from the UI.

## 🛠️ Tech Stack

*   **Frontend**: Vanilla JavaScript, HTML5, CSS3 (Modern Variables & Flexbox).
*   **P2P Engine**: [PeerJS](https://peerjs.com/) (WebRTC wrapper).
*   **Signaling**: [Socket.IO](https://socket.io/) (for room discovery and handshake).
*   **Backend**: Node.js & Express (for signaling only).
*   **Icons**: [Phosphor Icons](https://phosphoricons.com/).

## 🚀 Getting Started

### Prerequisites

*   [Node.js](https://nodejs.org/) (v14 or higher)
*   [npm](https://www.npmjs.com/)

### Installation

1.  **Clone the repository**
    ```bash
    git clone https://github.com/yourusername/supergo.git
    cd supergo
    ```

2.  **Install dependencies**
    ```bash
    npm install
    ```

3.  **Start the server**
    ```bash
    npm start
    ```

4.  **Open in Browser**
    *   **Localhost**: Visit `http://localhost:3000` on the host machine.
    *   **Local Network (LAN)**: Find your computer's local IP address (e.g., `192.168.1.5`) and visit `http://192.168.1.5:3000` on other devices connected to the same WiFi/Network.

> **Note**: This application is designed for **Local Network (LAN)** usage by default. To use it over the internet (globally), you must deploy it to a public server (e.g., Heroku, Render).

## 📖 How to Use

1.  **Create a Room**:
    *   Enter your name.
    *   Choose **Public** (visible to all) or **Private** (requires code).
    *   Click "Start Room".

2.  **Share Files**:
    *   Drag & Drop files/folders into the upload area.
    *   Select the files you want to share and click "Share Selected".

3.  **Join a Room**:
    *   **Public**: Click "Join" on any room in the list.
    *   **Private**: Click the room, enter the 6-digit code in the inline input, and press Enter.

4.  **Download**:
    *   Select the files you want to receive.
    *   Click "Download". Files are saved directly to your device.

## 🛡️ Security

SuperGO prioritizes your privacy:
*   **No Cloud Storage**: Files are streamed directly from sender to receiver.
*   **Ephemeral**: Rooms and file lists disappear when you leave.
*   **DTLS 1.3**: Industry-standard encryption for all data in transit.

## 🤝 Contributing

Contributions are welcome! The core logic is isolated in `public/super.js` (The `SuperGO` Class), making it easy to port or modify.

## 📄 License

MIT License. Feel free to use and modify!
