// US-only manual provisioning template: /etc/brawlock/accounts.config.cjs.
// Install root:brawlock 0640. Start only after the matching auth bundle and
// same-origin website/proxy are verified. Regional deploy.sh does not touch this.
module.exports = {
  apps: [{
    name: 'brawlock-accounts',
    script: 'accounts.mjs',
    cwd: '/opt/apps/brawlock-accounts',
    node_args: '--max-old-space-size=128 --disable-warning=ExperimentalWarning',
    env: {
      NODE_ENV: 'production',
      AUTH_ORIGIN: 'https://brawlock.osc.link',
      AUTH_PORT: '5352',
      AUTH_DATA_DIR: '/opt/apps/brawlock-accounts/data',
      AUTH_SECRET_FILE: '/etc/brawlock/accounts-session-secret',
      AUTH_GOOGLE_CLIENT_ID: '__GOOGLE_CLIENT_ID__',
      AUTH_GOOGLE_SECRET_FILE: '/etc/brawlock/accounts-google-secret',
      AUTH_REGIONS_TOKEN_FILE: '/etc/brawlock/rating-authority-token',
      // Optional feedback digests. Set both after verifying the sender domain in Resend.
      // RESEND_API_KEY: require('node:fs').readFileSync('/etc/brawlock/resend-api-key', 'utf8').trim(),
      // FEEDBACK_MAIL_FROM: 'Brawlock <feedback@brawlock.osc.link>',
      TRUST_PROXY: '1',
    },
    max_memory_restart: '180M',
    kill_timeout: 10000,
    time: true,
    merge_logs: true,
  }],
}
