#!/usr/bin/env bash
# Deploy the reviewed standalone US auth bundle; protected config/data stay put.
# Run from the same frozen source revision as the client and regional servers.
set -euo pipefail
host=${DEPLOY_HOST:-root@147.182.251.185}
test -f dist-accounts/accounts.mjs
ssh -o BatchMode=yes "$host" 'test "$(stat -c %U:%G:%a /opt/apps/brawlock-accounts)" = root:brawlock:750 && test "$(stat -c %U:%a /opt/apps/brawlock-accounts/data)" = brawlock:700 && test "$(stat -c %U:%G:%a /etc/brawlock/accounts.config.cjs)" = root:brawlock:640'
rsync -az dist-accounts/accounts.mjs "$host:/opt/apps/brawlock-accounts/accounts.next.mjs"
ssh -o BatchMode=yes "$host" bash -s <<'SH'
set -euo pipefail
chown root:brawlock /opt/apps/brawlock-accounts/accounts.next.mjs
chmod 0640 /opt/apps/brawlock-accounts/accounts.next.mjs
cd /var/lib/brawlock
bpm2() { runuser -u brawlock -- env -i HOME=/var/lib/brawlock USER=brawlock LOGNAME=brawlock PATH=/usr/local/bin:/usr/bin:/bin PM2_HOME=/var/lib/brawlock/.pm2 pm2 "$@"; }
# Verify configuration without printing credentials. Migration uses only its env.
runuser -u brawlock -- env -i HOME=/var/lib/brawlock PATH=/usr/local/bin:/usr/bin:/bin node --input-type=commonjs - <<'NODE'
const {spawnSync}=require('node:child_process')
const app=require('/etc/brawlock/accounts.config.cjs').apps.find(a=>a.name==='brawlock-accounts')
if(!app || app.cwd!=='/opt/apps/brawlock-accounts' || app.env.AUTH_ORIGIN!=='https://brawlock.osc.link' || !app.env.AUTH_REGIONS_TOKEN_FILE) throw new Error('Incomplete protected account configuration')
const result=spawnSync(process.execPath,['accounts.next.mjs','--migrate'],{cwd:app.cwd,env:{...process.env,...app.env},stdio:'inherit'})
if(result.status!==0) process.exit(result.status??1)
NODE
mv /opt/apps/brawlock-accounts/accounts.next.mjs /opt/apps/brawlock-accounts/accounts.mjs
bpm2 startOrRestart /etc/brawlock/accounts.config.cjs --only brawlock-accounts --update-env
bpm2 save
SH
