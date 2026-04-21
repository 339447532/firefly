const stripAnsi = require('strip-ansi');

class TUIParser {
  constructor(ws, pty) {
    this.ws = ws;
    this.pty = pty;
    this.buffer = [];
    this.maxLines = 25;
    this.isWaiting = false;
    this.patterns = {
      numbered: /\[\s*(\d+)\s*\]\s+([^\n\r]+)/g,
      yesno: /\(y\/[Nn]\)|\([Yy]\/n\)|\? \[y\/n\]/g,
      keyword: /(Continue|Proceed|Accept|Reject|Edit|Skip)/g
    };
    this.timer = null;
  }

  feed(chunk) {
    const clean = stripAnsi(chunk);
    const lines = clean.split(/\r?\n/).filter(line => line.trim().length > 0);

    for (const line of lines) {
      this.buffer.push(line);
      if (this.buffer.length > this.maxLines) {
        this.buffer.shift();
      }
    }

    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.detect();
    }, 60);
  }

  detect() {
    if (this.isWaiting) return;

    const recentText = this.buffer.join('\n');

    for (const [type, pattern] of Object.entries(this.patterns)) {
      pattern.lastIndex = 0;
      const matches = [...recentText.matchAll(pattern)];

      if (matches.length > 0) {
        const options = this.buildOptions(type, matches);
        const context = this.getContext();

        this.ws.send(JSON.stringify({
          type: 'tui_prompt',
          options,
          context,
          ts: Date.now()
        }));

        this.isWaiting = true;
        return;
      }
    }
  }

  buildOptions(type, matches) {
    switch (type) {
      case 'numbered':
        return matches.map(m => ({
          key: m[1],
          label: m[2].trim()
        }));

      case 'yesno':
        return [
          { key: 'y', label: 'Yes' },
          { key: 'n', label: 'No' }
        ];

      case 'keyword':
        return [
          { key: 'c', label: 'Continue' },
          { key: '\x03', label: 'Stop' }
        ];

      default:
        return [];
    }
  }

  getContext() {
    const lastLines = this.buffer.slice(-5);
    const context = lastLines.join('\n');
    return context.length > 300 ? context.substring(0, 300) : context;
  }

  handleAction(key) {
    this.pty.write(key);
    this.isWaiting = false;
  }
}

module.exports = TUIParser;
