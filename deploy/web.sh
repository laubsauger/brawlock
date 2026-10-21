#!/usr/bin/env bash
# Upload a reviewed package, then atomically activate its first-party app.
# Does not change nginx, auth, regional code, credentials, DNS or Pages.
set -euo pipefail
package=${1:?Usage: deploy/web.sh PACKAGE_DIR EXPECTED_BUILD [--stage-only|--activate-staged]}
expected=${2:?Expected build ID is required}
mode=${3:-}
case "$mode" in ''|--stage-only|--activate-staged) ;; *) echo 'Unknown option' >&2; exit 2;; esac
case "$expected" in ''|*[!a-zA-Z0-9._-]*) echo 'Invalid build ID' >&2; exit 2;; esac
host=${DEPLOY_HOST:-root@147.182.251.185}
node --input-type=module - "$package" "$expected" <<'NODE'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const [dir,expected]=process.argv.slice(2)
const hosting=JSON.parse(readFileSync(join(dir,'hosting.json'),'utf8'))
const version=JSON.parse(readFileSync(join(dir,'web/version.json'),'utf8'))
if(hosting.build!==expected || version.build!==expected || hosting.appOrigin!=='https://brawlock.osc.link') throw new Error('Package/version mismatch')
const allowed=new Set(['index.html','admin.html','sounds.html','about.html','privacy.html','terms.html','googlec523c567482e96c5.html','version.json','assets','brand'])
if(readdirSync(join(dir,'web')).some(name=>!allowed.has(name))) throw new Error('Unexpected first-party content')
NODE
release="/var/www/brawlock/releases/$expected"
if [ "$mode" != --activate-staged ]; then
  ssh -o BatchMode=yes "$host" "test ! -e '$release' && install -d -m 0755 '$release'"
  rsync -az "$package/web/" "$host:$release/"
fi
ssh -o BatchMode=yes "$host" bash -s -- "$release" "$expected" "$mode" <<'SH'
set -euo pipefail
release=$1 expected=$2 mode=$3
chown -R root:root "$release"
find "$release" -type d -exec chmod 0755 {} +
find "$release" -type f -exec chmod 0644 {} +
node --input-type=module - "$release" "$expected" <<'NODE'
import { readFileSync } from 'node:fs'
const [dir,expected]=process.argv.slice(2)
if(JSON.parse(readFileSync(`${dir}/version.json`,'utf8')).build!==expected) throw new Error('Uploaded version mismatch')
NODE
if [ "$mode" = --stage-only ]; then
  printf 'Staged %s; current app unchanged.\n' "$expected"
  exit 0
fi
cd /var/www/brawlock
test ! -e current.next
ln -s "$release" current.next
mv -Tf current.next current
printf 'Activated %s\n' "$expected"
SH
