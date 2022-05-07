window.URL = window.URL || window.webkitURL;
window.isRtcSupported = !!(
  window.RTCPeerConnection ||
  window.mozRTCPeerConnection ||
  window.webkitRTCPeerConnection
);

class ServerConnection {
  constructor() {
    console.log("ServerConnection ==> constructor");
    this._connect();
    Events.on("beforeunload", (e) => this._disconnect());
    Events.on("pagehide", (e) => this._disconnect());
    document.addEventListener("visibilitychange", (e) =>
      this._onVisibilityChange()
    );
  }

  _connect() {
    console.log("ServerConnection ==> _connect");
    clearTimeout(this._reconnectTimer);
    if (this._isConnected() || this._isConnecting()) return;
    const ws = new WebSocket(this._endpoint());
    ws.binaryType = "arraybuffer";
    ws.onopen = (e) => console.log("WS: server connected");
    ws.onmessage = (e) => this._onMessage(e.data);
    ws.onclose = (e) => this._onDisconnect();
    ws.onerror = (e) => console.error(e);
    this._socket = ws;
  }

  _onMessage(msg) {
    console.log("ServerConnection ==> _onMessage");
    msg = JSON.parse(msg);
    console.log("WS:", msg);
    switch (msg.type) {
      case "peers":
        Events.fire("peers", msg.peers);
        break;
      case "peer-joined":
        Events.fire("peer-joined", msg.peer);
        break;
      case "peer-left":
        Events.fire("peer-left", msg.peerId);
        break;
      case "signal":
        Events.fire("signal", msg);
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "display-name":
        Events.fire("display-name", msg);
        break;
      default:
        console.error("WS: unkown message type", msg);
    }
  }

  send(message) {
    console.log("ServerConnection ==> send");
    if (!this._isConnected()) return;
    this._socket.send(JSON.stringify(message));
  }

  _endpoint() {
    //ws://localhost:5000:3000/server/webrtc
    console.log("ServerConnection ==> _endpoint");
    // hack to detect if deployment or development environment
    const protocol = location.protocol.startsWith("https") ? "wss" : "ws";
    const webrtc = window.isRtcSupported ? "/webrtc" : "/fallback";
    const url = protocol + "://localhost:3000/server" + webrtc;
    return url;
  }

  _disconnect() {
    console.log("ServerConnection ==> _disconnect");
    this.send({ type: "disconnect" });
    this._socket.onclose = null;
    this._socket.close();
  }

  _onDisconnect() {
    console.log("ServerConnection ==> _onDisconnect");
    console.log("WS: server disconnected");
    Events.fire("notify-user", "Connection lost. Retry in 5 seconds...");
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout((_) => this._connect(), 5000);
  }

  _onVisibilityChange() {
    console.log("ServerConnection ==> _onVisibilityChange");
    if (document.hidden) return;
    this._connect();
  }

  _isConnected() {
    console.log("ServerConnection ==> _isConnected");
    return this._socket && this._socket.readyState === this._socket.OPEN;
  }

  _isConnecting() {
    console.log("ServerConnection ==> _isConnecting");
    return this._socket && this._socket.readyState === this._socket.CONNECTING;
  }
}

class Peer {
  constructor(serverConnection, peerId) {
    console.log("Peer ==> constructor");
    this._server = serverConnection;
    this._peerId = peerId;
    this._filesQueue = [];
    this._busy = false;
  }

  sendJSON(message) {
    console.log("Peer ==> sendJSON");
    this._send(JSON.stringify(message));
  }

  sendFiles(files) {
    console.log("Peer ==> sendFiles");
    for (let i = 0; i < files.length; i++) {
      this._filesQueue.push(files[i]);
    }
    if (this._busy) return;
    this._dequeueFile();
  }

  _dequeueFile() {
    console.log("Peer ==> _dequeueFile");
    if (!this._filesQueue.length) return;
    this._busy = true;
    const file = this._filesQueue.shift();
    this._sendFile(file);
  }

  _sendFile(file) {
    console.log("Peer ==> _sendFile");
    this.sendJSON({
      type: "header",
      name: file.name,
      mime: file.type,
      size: file.size,
    });
    this._chunker = new FileChunker(
      file,
      (chunk) => this._send(chunk),
      (offset) => this._onPartitionEnd(offset)
    );
    this._chunker.nextPartition();
  }

  _onPartitionEnd(offset) {
    console.log("Peer ==> _onPartitionEnd");
    this.sendJSON({ type: "partition", offset: offset });
  }

  _onReceivedPartitionEnd(offset) {
    console.log("Peer ==> _onReceivedPartitionEnd");
    this.sendJSON({ type: "partition-received", offset: offset });
  }

  _sendNextPartition() {
    console.log("Peer ==> _sendNextPartition");
    if (!this._chunker || this._chunker.isFileEnd()) return;
    this._chunker.nextPartition();
  }

  _sendProgress(progress) {
    console.log("Peer ==> _sendProgress");
    this.sendJSON({ type: "progress", progress: progress });
  }

  _onMessage(message) {
    console.log("Peer ==> _onMessage");
    if (typeof message !== "string") {
      this._onChunkReceived(message);
      return;
    }
    message = JSON.parse(message);
    console.log("RTC:", message);
    switch (message.type) {
      case "header":
        this._onFileHeader(message);
        break;
      case "partition":
        this._onReceivedPartitionEnd(message);
        break;
      case "partition-received":
        this._sendNextPartition();
        break;
      case "progress":
        this._onDownloadProgress(message.progress);
        break;
      case "transfer-complete":
        this._onTransferCompleted();
        break;
      case "text":
        this._onTextReceived(message);
        break;
    }
  }

  _onFileHeader(header) {
    console.log("Peer ==> _onFileHeader");
    this._lastProgress = 0;
    this._digester = new FileDigester(
      {
        name: header.name,
        mime: header.mime,
        size: header.size,
      },
      (file) => this._onFileReceived(file)
    );
  }

  _onChunkReceived(chunk) {
    console.log("Peer ==> _onChunkReceived");
    if (!chunk.byteLength) return;

    this._digester.unchunk(chunk);
    const progress = this._digester.progress;
    this._onDownloadProgress(progress);

    // occasionally notify sender about our progress
    if (progress - this._lastProgress < 0.01) return;
    this._lastProgress = progress;
    this._sendProgress(progress);
  }

  _onDownloadProgress(progress) {
    console.log("Peer ==> _onDownloadProgress");
    Events.fire("file-progress", { sender: this._peerId, progress: progress });
  }

  _onFileReceived(proxyFile) {
    console.log("Peer ==> _onFileReceived");
    Events.fire("file-received", proxyFile);
    this.sendJSON({ type: "transfer-complete" });
  }

  _onTransferCompleted() {
    console.log("Peer ==> _onTransferCompleted");
    this._onDownloadProgress(1);
    this._reader = null;
    this._busy = false;
    this._dequeueFile();
    Events.fire("notify-user", "File transfer completed.");
  }

  sendText(text) {
    console.log("Peer ==> sendText");
    const unescaped = btoa(unescape(encodeURIComponent(text)));
    this.sendJSON({ type: "text", text: unescaped });
  }

  _onTextReceived(message) {
    console.log("Peer ==> _onTextReceived");
    const escaped = decodeURIComponent(escape(atob(message.text)));
    Events.fire("text-received", { text: escaped, sender: this._peerId });
  }
}

class RTCPeer extends Peer {
  constructor(serverConnection, peerId) {
    super(serverConnection, peerId);
    console.log("RTCPeer ==> constructor");
    if (!peerId) return; // we will listen for a caller
    this._connect(peerId, true);
  }

  _connect(peerId, isCaller) {
    console.log("RTCPeer ==> _connect");
    if (!this._conn) this._openConnection(peerId, isCaller);

    if (isCaller) {
      this._openChannel();
    } else {
      this._conn.ondatachannel = (e) => this._onChannelOpened(e);
    }
  }

  _openConnection(peerId, isCaller) {
    console.log("RTCPeer ==> _openConnection");
    this._isCaller = isCaller;
    this._peerId = peerId;
    this._conn = new RTCPeerConnection(RTCPeer.config);
    this._conn.onicecandidate = (e) => this._onIceCandidate(e);
    this._conn.onconnectionstatechange = (e) =>
      this._onConnectionStateChange(e);
    this._conn.oniceconnectionstatechange = (e) =>
      this._onIceConnectionStateChange(e);
  }

  _openChannel() {
    console.log("RTCPeer ==> _openChannel");
    const channel = this._conn.createDataChannel("data-channel", {
      ordered: true,
      reliable: true, // Obsolete. See https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/reliable
    });
    channel.binaryType = "arraybuffer";
    channel.onopen = (e) => this._onChannelOpened(e);
    this._conn
      .createOffer()
      .then((d) => this._onDescription(d))
      .catch((e) => this._onError(e));
  }

  _onDescription(description) {
    console.log("RTCPeer ==> _onDescription");
    // description.sdp = description.sdp.replace('b=AS:30', 'b=AS:1638400');
    this._conn
      .setLocalDescription(description)
      .then((_) => this._sendSignal({ sdp: description }))
      .catch((e) => this._onError(e));
  }

  _onIceCandidate(event) {
    console.log("RTCPeer ==> _onIceCandidate");
    if (!event.candidate) return;
    this._sendSignal({ ice: event.candidate });
  }

  onServerMessage(message) {
    console.log("RTCPeer ==> onServerMessage");
    if (!this._conn) this._connect(message.sender, false);

    if (message.sdp) {
      this._conn
        .setRemoteDescription(new RTCSessionDescription(message.sdp))
        .then((_) => {
          if (message.sdp.type === "offer") {
            return this._conn
              .createAnswer()
              .then((d) => this._onDescription(d));
          }
        })
        .catch((e) => this._onError(e));
    } else if (message.ice) {
      this._conn.addIceCandidate(new RTCIceCandidate(message.ice));
    }
  }

  _onChannelOpened(event) {
    console.log("RTCPeer ==> _onChannelOpened");
    console.log("RTC: channel opened with", this._peerId);
    const channel = event.channel || event.target;
    channel.onmessage = (e) => this._onMessage(e.data);
    channel.onclose = (e) => this._onChannelClosed();
    this._channel = channel;
  }

  _onChannelClosed() {
    console.log("RTCPeer ==> _onChannelClosed");
    console.log("RTC: channel closed", this._peerId);
    if (!this.isCaller) return;
    this._connect(this._peerId, true); // reopen the channel
  }

  _onConnectionStateChange(e) {
    console.log("RTCPeer ==> _onConnectionStateChange");
    console.log("RTC: state changed:", this._conn.connectionState);
    switch (this._conn.connectionState) {
      case "disconnected":
        this._onChannelClosed();
        break;
      case "failed":
        this._conn = null;
        this._onChannelClosed();
        break;
    }
  }

  _onIceConnectionStateChange() {
    console.log("RTCPeer ==> _onIceConnectionStateChange");
    switch (this._conn.iceConnectionState) {
      case "failed":
        console.error("ICE Gathering failed");
        break;
      default:
        console.log("ICE Gathering", this._conn.iceConnectionState);
    }
  }

  _onError(error) {
    console.log("RTCPeer ==> _onError");
    console.error(error);
  }

  _send(message) {
    console.log("RTCPeer ==> _send");
    if (!this._channel) return this.refresh();
    this._channel.send(message);
  }

  _sendSignal(signal) {
    console.log("RTCPeer ==> _sendSignal");
    signal.type = "signal";
    signal.to = this._peerId;
    this._server.send(signal);
  }

  refresh() {
    console.log("RTCPeer ==> refresh");
    // check if channel is open. otherwise create one
    if (this._isConnected() || this._isConnecting()) return;
    this._connect(this._peerId, this._isCaller);
  }

  _isConnected() {
    console.log("RTCPeer ==> _isConnected");
    return this._channel && this._channel.readyState === "open";
  }

  _isConnecting() {
    console.log("RTCPeer ==> _isConnecting");
    return this._channel && this._channel.readyState === "connecting";
  }
}

class PeersManager {
  constructor(serverConnection) {
    console.log("PeersManager ==> constructor");
    this.peers = {};
    this._server = serverConnection;
    Events.on("signal", (e) => this._onMessage(e.detail));
    Events.on("peers", (e) => this._onPeers(e.detail));
    Events.on("files-selected", (e) => this._onFilesSelected(e.detail));
    Events.on("send-text", (e) => this._onSendText(e.detail));
    Events.on("peer-left", (e) => this._onPeerLeft(e.detail));
  }

  _onMessage(message) {
    console.log("PeersManager ==> _onMessage");
    if (!this.peers[message.sender]) {
      this.peers[message.sender] = new RTCPeer(this._server);
    }
    this.peers[message.sender].onServerMessage(message);
  }

  _onPeers(peers) {
    console.log("PeersManager ==> _onPeers");
    peers.forEach((peer) => {
      if (this.peers[peer.id]) {
        this.peers[peer.id].refresh();
        return;
      }
      if (window.isRtcSupported && peer.rtcSupported) {
        this.peers[peer.id] = new RTCPeer(this._server, peer.id);
      } else {
        this.peers[peer.id] = new WSPeer(this._server, peer.id);
      }
    });
  }

  sendTo(peerId, message) {
    console.log("PeersManager ==> sendTo");
    this.peers[peerId].send(message);
  }

  _onFilesSelected(message) {
    console.log("PeersManager ==> _onFilesSelected");
    this.peers[message.to].sendFiles(message.files);
  }

  _onSendText(message) {
    console.log("PeersManager ==> _onSendText");
    this.peers[message.to].sendText(message.text);
  }

  _onPeerLeft(peerId) {
    console.log("PeersManager ==> _onPeerLeft");
    const peer = this.peers[peerId];
    delete this.peers[peerId];
    if (!peer || !peer._peer) return;
    peer._peer.close();
  }
}

class WSPeer {
  _send(message) {
    console.log("WSPeer ==> _send");
    message.to = this._peerId;
    this._server.send(message);
  }
}

class FileChunker {
  constructor(file, onChunk, onPartitionEnd) {
    console.log("FileChunker ==> constructor");
    this._chunkSize = 64000; // 64 KB
    this._maxPartitionSize = 1e6; // 1 MB
    this._offset = 0;
    this._partitionSize = 0;
    this._file = file;
    this._onChunk = onChunk;
    this._onPartitionEnd = onPartitionEnd;
    this._reader = new FileReader();
    this._reader.addEventListener("load", (e) =>
      this._onChunkRead(e.target.result)
    );
  }

  nextPartition() {
    console.log("FileChunker ==> nextPartition");
    this._partitionSize = 0;
    this._readChunk();
  }

  _readChunk() {
    console.log("FileChunker ==> _readChunk");
    const chunk = this._file.slice(
      this._offset,
      this._offset + this._chunkSize
    );
    this._reader.readAsArrayBuffer(chunk);
  }

  _onChunkRead(chunk) {
    console.log("FileChunker ==> _onChunkRead");
    this._offset += chunk.byteLength;
    this._partitionSize += chunk.byteLength;
    this._onChunk(chunk);
    if (this._isPartitionEnd() || this.isFileEnd()) {
      this._onPartitionEnd(this._offset);
      return;
    }
    this._readChunk();
  }

  repeatPartition() {
    console.log("FileChunker ==> repeatPartition");
    this._offset -= this._partitionSize;
    this._nextPartition();
  }

  _isPartitionEnd() {
    console.log("FileChunker ==> _isPartitionEnd");
    return this._partitionSize >= this._maxPartitionSize;
  }

  isFileEnd() {
    console.log("FileChunker ==> isFileEnd");
    return this._offset >= this._file.size;
  }

  get progress() {
    console.log("FileChunker ==> progress");
    return this._offset / this._file.size;
  }
}

class FileDigester {
  constructor(meta, callback) {
    console.log("FileDigester ==> constructor");
    this._buffer = [];
    this._bytesReceived = 0;
    this._size = meta.size;
    this._mime = meta.mime || "application/octet-stream";
    this._name = meta.name;
    this._callback = callback;
  }

  unchunk(chunk) {
    console.log("FileDigester ==> unchunk");
    this._buffer.push(chunk);
    this._bytesReceived += chunk.byteLength || chunk.size;
    const totalChunks = this._buffer.length;
    this.progress = this._bytesReceived / this._size;
    if (isNaN(this.progress)) this.progress = 1;

    if (this._bytesReceived < this._size) return;
    // we are done
    let blob = new Blob(this._buffer, { type: this._mime });
    this._callback({
      name: this._name,
      mime: this._mime,
      size: this._size,
      blob: blob,
    });
  }
}

class Events {
  static fire(type, detail) {
    console.log("Events ==> fire");
    window.dispatchEvent(new CustomEvent(type, { detail: detail }));
  }

  static on(type, callback) {
    console.log("Events ==> on");
    return window.addEventListener(type, callback, false);
  }
}

RTCPeer.config = {
  sdpSemantics: "unified-plan",
  iceServers: [
    {
      urls: "stun:stun.l.google.com:19302",
    },
  ],
};
