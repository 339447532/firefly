/* global Terminal */

(function bootstrapTerminal() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";
  const fontSize = Number.parseInt(params.get("fontSize") || "12", 10);
  const container = document.getElementById("terminal-container");
  const wsProtocol = window.location.protocol === "https:" ? "wss://" : "ws://";
  const utf8Decoder = new TextDecoder("utf-8");
  const utf8Encoder = new TextEncoder();

  const postBridgeMessage = (payload) => {
    if (
      window.ReactNativeWebView &&
      typeof window.ReactNativeWebView.postMessage === "function"
    ) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      return;
    }

    if (window.parent && window.parent !== window) {
      window.parent.postMessage(JSON.stringify(payload), "*");
    }
  };

  const term = new Terminal({
    cursorBlink: true,
    fontSize: Number.isFinite(fontSize) ? fontSize : 12,
    theme: {
      background: "#1e1e1e",
      foreground: "#f0f0f0",
      cursor: "#00ff00",
      selection: "rgba(255,255,255,0.3)",
    },
    scrollback: 10000,
    allowTransparency: false,
    scrollSensitivity: 3,
    convertEol: true,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);

  window.term = term;
  window.terminalWS = null;

  let imeModeEnabled = false;
  let reconnectAttempts = 0;
  let lastImeRequestAt = 0;

  const requestImeKeyboard = () => {
    if (!imeModeEnabled) {
      return;
    }

    const now = Date.now();
    if (now - lastImeRequestAt < 200) {
      return;
    }

    lastImeRequestAt = now;
    postBridgeMessage({ type: "request_ime_keyboard" });
  };

  const configureHiddenTextarea = () => {
    const textarea = term.textarea;
    if (!textarea) {
      return;
    }

    textarea.readOnly = imeModeEnabled;
    if (imeModeEnabled) {
      textarea.setAttribute("readonly", "readonly");
      textarea.setAttribute("inputmode", "none");
    } else {
      textarea.removeAttribute("readonly");
      textarea.setAttribute("inputmode", "text");
    }
    textarea.setAttribute("autocorrect", "off");
    textarea.setAttribute("autocapitalize", "off");
    textarea.setAttribute("autocomplete", "off");
    textarea.setAttribute("spellcheck", "false");
    textarea.style.caretColor = imeModeEnabled ? "transparent" : "";
  };

  const focusNativeKeyboard = () => {
    const textarea = term.textarea;
    if (!textarea) {
      return;
    }

    configureHiddenTextarea();
    requestAnimationFrame(() => {
      textarea.focus();
    });
  };

  const setImeMode = (enabled) => {
    imeModeEnabled = Boolean(enabled);
    configureHiddenTextarea();
  };

  window.fireflySetImeMode = setImeMode;

  const bindImeTriggers = () => {
    const textarea = term.textarea;
    if (!textarea || textarea.dataset.fireflyImeBound === "true") {
      return;
    }

    textarea.dataset.fireflyImeBound = "true";
    configureHiddenTextarea();

    ["touchend", "mouseup"].forEach((eventName) => {
      const handleInteraction = () => {
        if (imeModeEnabled) {
          requestImeKeyboard();
          return;
        }

        focusNativeKeyboard();
      };

      container.addEventListener(eventName, handleInteraction);
      textarea.addEventListener(eventName, handleInteraction);
    });

    textarea.addEventListener("focus", () => {
      if (imeModeEnabled) {
        configureHiddenTextarea();
        requestImeKeyboard();
      }
    });
  };

  bindImeTriggers();

  const sendResize = () => {
    if (window.terminalWS && window.terminalWS.readyState === WebSocket.OPEN) {
      window.terminalWS.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })
      );
    }
  };

  const fitTerminal = () => {
    fitAddon.fit();
    sendResize();
  };

  term.onData((data) => {
    if (window.terminalWS && window.terminalWS.readyState === WebSocket.OPEN) {
      window.terminalWS.send(utf8Encoder.encode(data));
    }
  });

  const connectWebSocket = () => {
    const ws = new WebSocket(
      wsProtocol + window.location.host + "?token=" + encodeURIComponent(token)
    );
    ws.binaryType = "arraybuffer";
    window.terminalWS = ws;

    ws.onopen = () => {
      reconnectAttempts = 0;
      postBridgeMessage({ type: "connected" });
      ws.send(JSON.stringify({ type: "recover_screen" }));
      requestAnimationFrame(() => {
        configureHiddenTextarea();
        fitTerminal();
        term.focus();
      });
    };

    ws.onmessage = async (event) => {
      if (typeof event.data === "string") {
        try {
          const payload = JSON.parse(event.data);
          postBridgeMessage(payload);
          return;
        } catch (_error) {
          term.write(event.data);
          return;
        }
      }

      if (event.data instanceof ArrayBuffer) {
        term.write(utf8Decoder.decode(new Uint8Array(event.data), { stream: true }));
        return;
      }

      if (event.data instanceof Blob) {
        const buffer = await event.data.arrayBuffer();
        term.write(utf8Decoder.decode(new Uint8Array(buffer), { stream: true }));
      }
    };

    ws.onclose = () => {
      const pendingText = utf8Decoder.decode();
      if (pendingText) {
        term.write(pendingText);
      }

      postBridgeMessage({ type: "disconnected" });

      if (reconnectAttempts < 12) {
        const delay = Math.min(800 * 2 ** reconnectAttempts, 30000);
        reconnectAttempts += 1;
        window.setTimeout(connectWebSocket, delay);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  };

  window.addEventListener("resize", () => {
    fitTerminal();
  });

  requestAnimationFrame(() => {
    configureHiddenTextarea();
    fitTerminal();
    term.focus();
  });

  connectWebSocket();
})();
