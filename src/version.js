// check if running the latest version

import { log } from 'console';
import { exec } from 'child_process';

const execp = cmd => new Promise((resolve, reject) => {
  exec(cmd, (error, stdout, stderr) => {
    if (stderr) console.error(`stderr: ${stderr}`);
    // if (stdout) console.log(`stdout: ${stdout}`);
    if (error) {
      console.log(`error: ${error.message}`);
      if (error.message.includes('command not found')) {
        console.info('Install git to check for updates!');
      }
      return reject(error);
    }
    resolve(stdout.trim());
  });
});

const sha = await execp('git rev-parse HEAD');
const date = await execp('git show -s --format=%cD'); // same format as `date -R` (RFC2822)
// const date = await execp('git show -s --format=%ch'); // %ch is same as --date=human (short/relative)

const gh = await (await fetch('https://api.github.com/repos/dankmaster/free-games-claimer/commits/main', {
  // headers: { accept: 'application/vnd.github.VERSION.sha' }
})).json();
// log(gh);

log('Local commit:', sha, new Date(date));
log('Online commit:', gh.sha, new Date(gh.commit.committer.date));

// git describe --all --long --dirty
// --> heads/main-0-gdee47d2-dirty
// git describe --tags --long --dirty
// --> v1.7-35-gdee47d2-dirty

if (sha == gh.sha) {
  log('Running the latest version!');
} else {
  log('Not running the latest version!');
}
