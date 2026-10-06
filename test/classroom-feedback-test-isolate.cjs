// Preload for local validation: keep Hydro profiles out of the user's home.
// Run with NODE_OPTIONS=--require=<absolute path to this file>.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const profile = path.resolve(__dirname, '../.cache/feedback-test-run');
const home = path.join(profile, 'home');
fs.mkdirSync(home, { recursive: true });
os.homedir = () => home;
process.env.HYDRO_PROFILE = profile;
process.env.CI = 'true';
for (const [name, content] of [['config.json', '{}'], ['addon.json', '[]']]) {
    const file = path.join(profile, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, content);
}
