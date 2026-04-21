const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const tmuxPath = process.env.TMUX_PATH || '/opt/homebrew/bin/tmux';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

class TmuxManager {
  constructor(session) {
    this.session = session;
  }

  async run(args) {
    try {
      const { stdout } = await execAsync(`${tmuxPath} ${args}`);
      return stdout.trim();
    } catch (error) {
      return '';
    }
  }

  async getLayout() {
    const output = await this.run(
      `list-panes -t ${shellQuote(this.session)} -F '#{pane_index} | #{pane_current_command} | #{pane_width}x#{pane_height}'`
    );
    if (!output) return [];

    return output.split('\n').map(line => {
      const [index, command, size] = line.split(' | ');
      return { index, command, size };
    });
  }

  async split(dir = 'v') {
    const splitCmd = dir === 'h' ? 'split-window -h' : 'split-window -v';
    await this.run(`${splitCmd} -t ${shellQuote(this.session)}`);
    await this.run(`select-layout -t ${shellQuote(this.session)} even-horizontal`);
  }

  async switchTo(idx) {
    await this.run(`select-pane -t ${shellQuote(`${this.session}:${idx}`)}`);
  }

  async closePane(idx) {
    await this.run(`kill-pane -t ${shellQuote(`${this.session}:${idx}`)}`);
  }

  async scrollPageUp() {
    // Enter copy-mode if not already in it, then scroll up
    await execAsync(`${tmuxPath} copy-mode -t ${shellQuote(this.session)}`);
    await execAsync(`${tmuxPath} send-keys -t ${shellQuote(this.session)} -X page-up`);
  }

  async scrollPageDown() {
    // Send page-down in copy-mode
    await execAsync(`${tmuxPath} send-keys -t ${shellQuote(this.session)} -X page-down`);
  }

  async scrollToTop() {
    // Enter copy-mode and jump to history top
    await execAsync(`${tmuxPath} copy-mode -t ${shellQuote(this.session)}`);
    await execAsync(`${tmuxPath} send-keys -t ${shellQuote(this.session)} -X history-top`);
  }

  async scrollToBottom() {
    // Exit copy-mode (returns to bottom)
    await execAsync(`${tmuxPath} send-keys -t ${shellQuote(this.session)} -X cancel`);
  }

  async newSession(newName) {
    await execAsync(`${tmuxPath} new-session -d -s ${shellQuote(newName)}`);
    this.session = newName;
  }
}

module.exports = TmuxManager;
