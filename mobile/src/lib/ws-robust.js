export class RobustWS {
  constructor(url, opts = {}) {
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxAttempts = opts.maxAttempts || 12;
    this.baseDelay = opts.baseDelay || 800;
    this.maxDelay = 30000;
    this.onMessage = opts.onMessage;
    this.onOpen = opts.onOpen;
    this.onClose = opts.onClose;
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) {
      return;
    }

    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      if (this.onOpen) {
        this.onOpen();
      }
      this.send({ action: 'recover_screen' });
    };

    this.ws.onmessage = (event) => {
      let data = event.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (e) {
        }
      }
      if (this.onMessage) {
        this.onMessage(data);
      }
    };

    this.ws.onclose = () => {
      if (this.onClose) {
        this.onClose();
      }
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.ws.close();
    };
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxAttempts) {
      return;
    }

    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.reconnectAttempts),
      this.maxDelay
    );
    this.reconnectAttempts++;

    setTimeout(() => this.connect(), delay);
  }

  send(d) {
    if (this.ws && this.ws.readyState === 1) {
      if (typeof d === 'object') {
        this.ws.send(JSON.stringify(d));
      } else {
        this.ws.send(d);
      }
    }
  }

  close() {
    this.reconnectAttempts = this.maxAttempts;
    if (this.ws) {
      this.ws.close();
    }
  }
}
