import pty from 'node-pty';
const tmuxPath = process.env.TMUX_PATH || '/opt/homebrew/bin/tmux';
console.log('Spawning:', tmuxPath);
try {
  const p = pty.spawn(tmuxPath, ['-V'], { env: process.env });
  p.onData(d => console.log('Data:', d));
} catch (e) {
  console.error('Error:', e);
}
