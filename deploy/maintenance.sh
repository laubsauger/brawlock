#!/usr/bin/env bash
# Operator-only regional controls. The credential stays on the remote host.
set -euo pipefail
action=${1:-status}
message=${2:-}
case "$action" in status|drain|reopen) ;; *) echo 'Usage: deploy/maintenance.sh status|drain|reopen [public-message]' >&2; exit 2;; esac
if [ "$action" != drain ] && [ -n "$message" ]; then echo 'Only drain accepts a public message' >&2; exit 2; fi
host=${DEPLOY_HOST:-root@147.182.251.185}
payload=$(node --input-type=module - "$message" <<'NODE'
const message=process.argv[2]
if(message.length>160 || /[\u0000-\u001f\u007f-\u009f]/.test(message)) throw new Error('Use a public message of at most 160 characters')
process.stdout.write(Buffer.from(message).toString('base64'))
NODE
)
# action is enumerated and payload is base64, never executable shell text.
ssh -o BatchMode=yes "$host" "node --input-type=commonjs - '$action' '$payload'" <<'NODE'
const fs=require('node:fs')
const [action,payload]=process.argv.slice(2)
const app=require('/etc/brawlock/ecosystem.config.cjs').apps.find(a=>a.name==='brawlock-server')
if(!app?.env?.MAINTENANCE_SECRET_FILE || !/^\d+$/.test(String(app.env.PORT))) throw new Error('Maintenance is not provisioned on this region')
const token=fs.readFileSync(app.env.MAINTENANCE_SECRET_FILE,'utf8').trim()
const message=Buffer.from(payload,'base64').toString('utf8')
const body=action==='status'?null:{draining:action==='drain',message:action==='drain'&&message?message:null}
;(async()=>{
 const response=await fetch(`http://127.0.0.1:${app.env.PORT}/internal/maintenance`,{
  method:body?'POST':'GET',headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'
 })
 if(!response.ok) throw new Error(`Maintenance request failed: HTTP ${response.status}`)
 console.log(JSON.stringify({region:app.env.REGION,...await response.json()},null,2))
})().catch(error=>{console.error(error.message);process.exitCode=1})
NODE
