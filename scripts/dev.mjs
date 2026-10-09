import { spawn } from 'node:child_process';
const children = ['server', 'web'].map((dir) =>
  spawn('npm', ['--prefix', dir, 'run', 'dev'], { stdio: 'inherit' }),
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
};
for (const child of children)
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
