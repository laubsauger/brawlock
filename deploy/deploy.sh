#!/usr/bin/env bash
# Deploy code through SSH as root; run the prepared app only as brawlock.
# Protected regional environment/secrets in /etc/brawlock are never overwritten.
#   deploy/deploy.sh --dry-run       print commands without building or connecting
#   deploy/deploy.sh --setup         also install this nginx site and certificate
# Env: DEPLOY_HOST, DOMAIN, REGION, PORT, APP_DIR (US West defaults below).
set -euo pipefail

DEPLOY_HOST=${DEPLOY_HOST:-root@147.182.251.185}
DOMAIN=${DOMAIN:-us.brawlock.osc.link}
REGION=${REGION:-us-west}
PORT=${PORT:-3077}
APP_DIR=${APP_DIR:-/opt/apps/brawlock-server}
APP=brawlock-server
RUNTIME_USER=brawlock
RUNTIME_HOME=/var/lib/brawlock
PM2_HOME_DIR=$RUNTIME_HOME/.pm2
PROTECTED_CONFIG=/etc/brawlock/ecosystem.config.cjs

DRY=0
SETUP=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --setup) SETUP=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
remote() {
  if [ "$DRY" = 1 ]; then echo "+ ssh $DEPLOY_HOST $*"; else ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"; fi
}
# Pass paths as quoted positional arguments, never interpolate them into script code.
remote_script() {
  local quoted
  printf -v quoted '%q ' "$@"
  if [ "$DRY" = 1 ]; then
    printf '+ ssh %s bash -s -- %s\n' "$DEPLOY_HOST" "$quoted"
    cat
  else
    ssh -o BatchMode=yes "$DEPLOY_HOST" "bash -s -- $quoted"
  fi
}

cd "$(git rev-parse --show-toplevel)"
case "$REGION" in
  *[!a-z0-9-]* | "" | -*) echo "REGION must be a lowercase id like us-west (the id in VITE_GAME_SERVERS)" >&2; exit 2 ;;
esac
case "$DOMAIN" in
  *[!a-zA-Z0-9.-]* | "" | -*) echo "DOMAIN must be a DNS hostname" >&2; exit 2 ;;
esac
case "$PORT" in
  *[!0-9]* | "") echo "PORT must be between 1 and 65535" >&2; exit 2 ;;
esac
if [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echo "PORT must be between 1 and 65535" >&2; exit 2; fi
case "$APP_DIR" in
  *[!a-zA-Z0-9_./-]* | / | "") echo "APP_DIR must be an absolute prepared app path without shell metacharacters or spaces" >&2; exit 2 ;;
  /*) ;;
  *) echo "APP_DIR must be an absolute prepared app directory" >&2; exit 2 ;;
esac

say "$REGION: $DOMAIN on $DEPLOY_HOST"
say "build (netcode id must match the published client build)"
if [ -n "$(git status --porcelain -- src/sim src/net server scripts/net-id.mjs scripts/build-server.mjs)" ]; then
  echo "uncommitted netcode or server changes: publish the matching client/server revision first (clients would be refused)" >&2
  [ "$DRY" = 1 ] || exit 1
fi
if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  echo "warning: HEAD is not on origin/main (as of the last fetch); GitHub Pages may serve another netcode" >&2
fi
if [ "$DRY" = 1 ]; then
  echo "+ npm run server:build"
  echo "+ cat dist-server/version.json"
else
  npm run server:build
  cat dist-server/version.json
fi

say "prepared nonroot runtime and protected regional config"
remote_script "$APP" "$APP_DIR" "$RUNTIME_USER" "$RUNTIME_HOME" "$PM2_HOME_DIR" "$PROTECTED_CONFIG" "$PORT" "$REGION" <<'SH'
set -euo pipefail
app=$1 app_dir=$2 runtime_user=$3 runtime_home=$4 pm2_home=$5 config=$6 port=$7 region=$8
fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail 'Deploy SSH identity must be root; the app runtime remains brawlock.'
for cmd in node pm2 rsync runuser systemctl ss curl; do command -v "$cmd" >/dev/null || fail "$cmd is missing on the host"; done
id "$runtime_user" >/dev/null 2>&1 || fail 'Prepared brawlock runtime account missing; complete the manual runtime setup first.'
[ "$(id -u "$runtime_user")" != 0 ] || fail 'The app runtime must not be root.'
[ "$(stat -c '%U:%G:%a' "$app_dir")" = "root:$runtime_user:750" ] || fail 'Prepared app directory must be root:brawlock mode 0750.'
[ "$(stat -c '%U:%a' "$app_dir/data")" = "$runtime_user:700" ] || fail 'Prepared data directory must be owned by brawlock mode 0700; deployment never changes data ownership.'
[ "$(stat -c '%U:%G:%a' "$config")" = "root:$runtime_user:640" ] || fail 'Protected /etc/brawlock/ecosystem.config.cjs must exist as root:brawlock mode 0640.'
[ "$(stat -c '%U:%G:%a' "$(dirname "$config")")" = "root:$runtime_user:750" ] || fail 'Protected /etc/brawlock must be root:brawlock mode 0750.'
systemctl is-active --quiet "pm2-$runtime_user" || fail 'Prepared pm2-brawlock systemd service is not active; complete manual runtime setup first.'
# PM2 must never inherit /root as cwd, HOME, or an ambient deployment environment.
cd "$runtime_home"
runtime_exec() {
  runuser -u "$runtime_user" -- env -i HOME="$runtime_home" USER="$runtime_user" LOGNAME="$runtime_user" PATH=/usr/local/bin:/usr/bin:/bin PM2_HOME="$pm2_home" "$@"
}
runtime_exec node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' || fail 'Node 24+ is missing from the brawlock runtime PATH.'
runtime_exec sh -c 'command -v pm2 >/dev/null && test -r "$1" && test -x "$2" && test -w "$2/data"' sh "$config" "$app_dir" || fail 'The brawlock runtime cannot read its protected config/code or write its data directory.'
# Check protected regional values without printing any credentials.
runtime_exec node - "$config" "$app" "$app_dir" "$port" "$region" <<'NODE'
const [file,name,cwd,port,region]=process.argv.slice(2)
const app=require(file).apps.find(app=>app.name===name)
if(!app || app.cwd!==cwd || String(app.env?.PORT)!==port || app.env?.REGION!==region) {
  console.error('Protected regional config does not match APP_DIR, PORT and REGION; update it manually before deployment.')
  process.exit(1)
}
NODE
has_app() {
  node -e 'let text="";process.stdin.on("data",chunk=>text+=chunk);process.stdin.on("end",()=>{const apps=JSON.parse(text);process.stdout.write(apps.some(app=>app.name===process.argv[1])?"yes":"no")})' "$app"
}
# Do not create or restart a root PM2 daemon just to inspect it. Check its saved
# startup inventory as well, so a reboot cannot resurrect the old root app.
if [ -f /root/.pm2/dump.pm2 ]; then
  root_saved=$(has_app < /root/.pm2/dump.pm2) || fail 'Cannot inspect the root PM2 saved inventory.'
  [ "$root_saved" = no ] || fail 'Root PM2 still owns brawlock-server in its saved inventory. Complete the manual one-time migration; deployment will not stop root apps or fall back to root.'
fi
if [ -r /root/.pm2/pm2.pid ]; then
  root_pid=$(cat /root/.pm2/pm2.pid)
  if [[ "$root_pid" =~ ^[0-9]+$ ]] && kill -0 "$root_pid" 2>/dev/null && [ -S /root/.pm2/rpc.sock ]; then
    root_live=$(env -i HOME=/root USER=root LOGNAME=root PATH=/usr/local/bin:/usr/bin:/bin PM2_HOME=/root/.pm2 pm2 jlist | has_app) || fail 'Cannot inspect the running root PM2 inventory.'
    [ "$root_live" = no ] || fail 'Root PM2 still owns brawlock-server. Complete the manual one-time migration; deployment will not stop root apps or fall back to root.'
  fi
fi
runtime_owns=$(runtime_exec pm2 jlist | has_app) || fail 'Cannot inspect the prepared brawlock PM2 inventory.'
if ss -ltn "sport = :$port" | grep -q LISTEN && [ "$runtime_owns" != yes ]; then
  fail "Port $port is already occupied outside the brawlock PM2 app. Resolve it manually before deployment."
fi
SH
if [ "$SETUP" = 1 ]; then
  remote "command -v nginx >/dev/null && command -v certbot >/dev/null && test -d /etc/nginx/sites-enabled || { echo 'nginx (sites-enabled layout) and certbot with the nginx plugin are needed' >&2; exit 1; }"
fi

say "code only → $APP_DIR (protected config and data preserved)"
if [ "$DRY" = 1 ]; then
  printf '+ rsync -rz --checksum --no-owner --no-group --no-perms --rsync-path=%q dist-server/server.mjs dist-server/version.json %q\n' 'umask 0077 && rsync' "$DEPLOY_HOST:$APP_DIR/"
else
  rsync -rz --checksum --no-owner --no-group --no-perms --rsync-path='umask 0077 && rsync' dist-server/server.mjs dist-server/version.json "$DEPLOY_HOST:$APP_DIR/"
fi
# The bundle is self-contained: no npm install, config copy, or data mutation.
remote_script "$APP_DIR" "$RUNTIME_USER" <<'SH'
set -euo pipefail
app_dir=$1 runtime_user=$2
chown "root:$runtime_user" "$app_dir/server.mjs" "$app_dir/version.json"
chmod 0640 "$app_dir/server.mjs" "$app_dir/version.json"
SH

say "brawlock PM2: reload or first start from protected config, then save"
remote_script "$APP" "$RUNTIME_USER" "$RUNTIME_HOME" "$PM2_HOME_DIR" "$PROTECTED_CONFIG" <<'SH'
set -euo pipefail
app=$1 runtime_user=$2 runtime_home=$3 pm2_home=$4 config=$5
umask 0077
cd "$runtime_home"
runtime_pm2() {
  runuser -u "$runtime_user" -- env -i HOME="$runtime_home" USER="$runtime_user" LOGNAME="$runtime_user" PATH=/usr/local/bin:/usr/bin:/bin PM2_HOME="$pm2_home" pm2 "$@"
}
if runtime_pm2 describe "$app" >/dev/null 2>&1; then
  runtime_pm2 reload "$config" --only "$app" --update-env
else
  runtime_pm2 start "$config" --only "$app"
fi
runtime_pm2 save
SH

say "health"
remote "for i in 1 2 3 4 5 6 7 8; do curl -fsS http://127.0.0.1:$PORT/health && exit 0; sleep 1; done; echo 'no health answer' >&2; exit 1"

if [ "$SETUP" = 1 ]; then
  SITE=/etc/nginx/sites-available/$DOMAIN
  say "nginx site $SITE (only this file)"
  if [ "$DRY" = 1 ]; then
    echo "+ if $SITE is absent on $DEPLOY_HOST: render deploy/nginx/site.conf into it and link it into sites-enabled"
  elif ssh -o BatchMode=yes "$DEPLOY_HOST" "test -e $SITE"; then
    echo "site exists, left as is"
  else
    sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" deploy/nginx/site.conf | ssh -o BatchMode=yes "$DEPLOY_HOST" "cat > $SITE"
    remote "ln -sf $SITE /etc/nginx/sites-enabled/$DOMAIN"
  fi
  remote "if nginx -t; then systemctl reload nginx; else rm -f /etc/nginx/sites-enabled/$DOMAIN; echo 'nginx -t failed: brawlock site disabled, nginx untouched' >&2; exit 1; fi"
  say "certificate for $DOMAIN (DNS A record must point here first)"
  remote "certbot --nginx -d $DOMAIN --non-interactive --redirect --keep-until-expiring && nginx -t && systemctl reload nginx"
  remote "curl -fsS https://$DOMAIN/health"
fi

say "done: wss://$DOMAIN/ws, https://$DOMAIN/health"
