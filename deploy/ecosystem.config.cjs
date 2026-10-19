// Manual provisioning template for /etc/brawlock/ecosystem.config.cjs.
// Install as root:brawlock 0640 under /etc/brawlock (root:brawlock 0750),
// replace the regional values, and add the protected authority/TURN environment.
// deploy.sh NEVER renders or copies this file over the live regional config.
const APP_DIR = '/opt/apps/brawlock-server'
const { readFileSync } = require('node:fs')
module.exports = {
  apps: [
    {
      name: 'brawlock-server',
      script: 'server.mjs',
      cwd: APP_DIR,
      // node:sqlite is unflagged on Node 22.13+ but prints an ExperimentalWarning.
      node_args: '--max-old-space-size=384 --disable-warning=ExperimentalWarning',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '__PORT__',
        TRUST_PROXY: '1',
        MAX_ROOMS: '100',
        ALLOWED_ORIGINS: '__ORIGINS__',
        REGION: '__REGION__',
        DATA_DIR: require('node:path').join(APP_DIR, 'data'),
        // US authority: empty URL uses its existing canonical SQLite database.
        // Other regions: the HTTPS US authority URL, never an independent ladder.
        RATING_AUTHORITY_URL: '__RATING_AUTHORITY_URL__',
        RATING_AUTHORITY_TOKEN: readFileSync('/etc/brawlock/rating-authority-token', 'utf8').trim(),
        // One shared account authority runs on the US host; matches run regionally.
        // On the US game server use http://127.0.0.1:5352 (same machine).
        // On the EU game server use https://us.brawlock.osc.link (private API).
        ACCOUNTS_AUTHORITY_URL: '__ACCOUNTS_AUTHORITY_URL__',
        MAINTENANCE_SECRET_FILE: '/etc/brawlock/maintenance-secret',
        TURN_SECRET_FILE: '/etc/brawlock/turn-secret',
        TURN_URLS: JSON.stringify([
          'turn:__TURN_HOST__:3478?transport=udp',
          'turn:__TURN_HOST__:3478?transport=tcp',
          'turns:__TURN_HOST__:5349?transport=tcp',
        ]),
      },
      max_memory_restart: '450M',
      kill_timeout: 5000,
      time: true,
      merge_logs: true,
    },
  ],
}
