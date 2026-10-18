// pm2 app for the brawlock dedicated server. Rendered by deploy/deploy.sh (__PORT__,
// __ORIGINS__, __REGION__) next to server.mjs in the app directory.
module.exports = {
  apps: [
    {
      name: 'brawlock-server',
      script: 'server.mjs',
      cwd: __dirname,
      // node:sqlite (the leaderboard) is unflagged on Node 22.13+ but prints an ExperimentalWarning
      node_args: '--max-old-space-size=384 --disable-warning=ExperimentalWarning',
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '__PORT__',
        TRUST_PROXY: '1',
        MAX_ROOMS: '100',
        ALLOWED_ORIGINS: '__ORIGINS__',
        REGION: '__REGION__',
        // leaderboard.sqlite; deploy.sh never touches this directory
        DATA_DIR: require('node:path').join(__dirname, 'data'),
      },
      max_memory_restart: '450M',
      kill_timeout: 5000,
      time: true,
      merge_logs: true,
    },
  ],
}
