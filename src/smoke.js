export function smokeExit(name) {
  if (process.env.SMOKE == '1') {
    console.log(`smoke ok: ${name}`);
    process.exit(0);
  }
}
