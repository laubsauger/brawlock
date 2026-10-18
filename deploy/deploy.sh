#!/usr/bin/env bash
# Deploy the brawlock dedicated server to a host with pm2 + nginx + certbot (deploy/README.md).
# Idempotent: build, rsync to APP_DIR, pm2 reload (or first start), save, health check.
#   deploy/deploy.sh                 update the server
#   deploy/deploy.sh --setup         also install the nginx site (first time) and get the certificate
#   deploy/deploy.sh --dry-run       print what would run, touch nothing
# Env: DEPLOY_HOST (root@147.182.251.185), DOMAIN (brawlock.osc.link), REGION (us-west),
#      PORT (3077), APP_DIR (/opt/apps/brawlock-server),
#      ALLOWED_ORIGINS (https://laubsauger.github.io)
# One region per host: a second region is the same script with another DEPLOY_HOST,
# DOMAIN and REGION, plus its entry in VITE_GAME_SERVERS (README "Regions").
# Never touches other nginx sites, other pm2 apps, UFW or docker; nginx is only ever
# reloaded after `nginx -t` passes.
set -euo pipefail

DEPLOY_HOST=${DEPLOY_HOST:-root@147.182.251.185}
DOMAIN=${DOMAIN:-brawlock.osc.link}
REGION=${REGION:-us-west}
PORT=${PORT:-3077}
APP_DIR=${APP_DIR:-/opt/apps/brawlock-server}
ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-https://laubsauger.github.io}
APP=brawlock-server

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

cd "$(git rev-parse --show-toplevel)"

case "$REGION" in
  *[!a-z0-9-]* | "" | -*) echo "REGION must be a lowercase id like us-west (the id in VITE_GAME_SERVERS)" >&2; exit 2 ;;
esac

say "$REGION: $DOMAIN on $DEPLOY_HOST"
say "build (netcode id must match the deployed client build)"
if [ -n "$(git status --porcelain -- src/sim src/net server scripts/net-id.mjs scripts/build-server.mjs)" ]; then
  echo "uncommitted netcode or server changes: commit and push first (clients would be refused)" >&2
  [ "$DRY" = 1 ] || exit 1
fi
if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
  echo "warning: HEAD is not on origin/main (as of the last fetch); GitHub Pages may serve another netcode" >&2
fi
npm run server:build
sed -e "s|__PORT__|$PORT|g" -e "s|__ORIGINS__|$ALLOWED_ORIGINS|g" -e "s|__REGION__|$REGION|g" deploy/ecosystem.config.cjs > dist-server/ecosystem.config.cjs
cat dist-server/version.json

say "host prerequisites: node 22+, pm2, rsync$([ "$SETUP" = 1 ] && echo ', nginx, certbot')"
remote "command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(\".\")[0] >= 22 ? 0 : 1)' || { echo 'node 22+ missing' >&2; exit 1; }; command -v pm2 >/dev/null || { echo 'pm2 missing (npm i -g pm2, then pm2 startup)' >&2; exit 1; }; command -v rsync >/dev/null || { echo 'rsync missing' >&2; exit 1; }"
if [ "$SETUP" = 1 ]; then
  remote "command -v nginx >/dev/null && command -v certbot >/dev/null && test -d /etc/nginx/sites-enabled || { echo 'nginx (sites-enabled layout) and certbot with the nginx plugin are needed' >&2; exit 1; }"
fi

say "port $PORT on $DEPLOY_HOST: free, or already $APP"
remote "if ss -ltn 'sport = :$PORT' | grep -q LISTEN && ! pm2 describe $APP >/dev/null 2>&1; then echo 'port $PORT is taken by something else' >&2; exit 1; fi"

say "files → $APP_DIR"
remote "mkdir -p $APP_DIR"
if [ "$DRY" = 1 ]; then
  echo "+ rsync -az --checksum dist-server/{server.mjs,version.json,ecosystem.config.cjs} $DEPLOY_HOST:$APP_DIR/"
else
  rsync -az --checksum dist-server/server.mjs dist-server/version.json dist-server/ecosystem.config.cjs "$DEPLOY_HOST:$APP_DIR/"
fi
# the bundle is self-contained: no npm install on the host

say "pm2: reload or first start, then save"
remote "cd $APP_DIR && if pm2 describe $APP >/dev/null 2>&1; then pm2 reload ecosystem.config.cjs --update-env; else pm2 start ecosystem.config.cjs; fi && pm2 save"

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
  # never reload a config that does not test clean; undo our link if it broke the test
  remote "if nginx -t; then systemctl reload nginx; else rm -f /etc/nginx/sites-enabled/$DOMAIN; echo 'nginx -t failed: brawlock site disabled, nginx untouched' >&2; exit 1; fi"
  say "certificate for $DOMAIN (DNS A record must point here first)"
  remote "certbot --nginx -d $DOMAIN --non-interactive --redirect --keep-until-expiring && nginx -t && systemctl reload nginx"
  remote "curl -fsS https://$DOMAIN/health"
fi

say "done: wss://$DOMAIN/ws, https://$DOMAIN/health"
