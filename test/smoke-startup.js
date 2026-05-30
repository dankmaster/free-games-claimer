import { execFileSync } from 'node:child_process';

const entries = [
  'epic-games.js',
  'prime-gaming.js',
  'gog.js',
  'unrealengine.js',
];

for (const entry of entries) {
  process.stdout.write(`Smoke ${entry} ... `);
  execFileSync(process.execPath, [entry], {
    env: { ...process.env, SMOKE: '1' },
    stdio: 'ignore',
  });
  console.log('ok');
}
