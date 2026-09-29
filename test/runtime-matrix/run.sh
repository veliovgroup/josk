#!/usr/bin/env bash
# Runtime matrix: runs the josk suites on each nvm-installed Node with a dev-toolchain
# that supports that Node. Usage: run.sh [MONGO_HOST_PORT] [label ...]
# Needs nvm Node versions under ~/.nvm/versions/node. Redis and Postgres are not exercised.
# Creates and drops only its own uniquely named "*-test" Mongo DBs.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$HERE/../.."
MONGO="${1:-127.0.0.1:27042}"; shift || true
ONLY=" $* "
WORK="$(mktemp -d /tmp/josk-matrix.XXXXXX)"
NVM="$HOME/.nvm/versions/node"
LATEST="$(ls "$NVM" | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)"
TOOL="$NVM/$LATEST/bin"; export PATH="$TOOL:$PATH"
# label|node|mongodb|mocha|chai|jest|cron-parser|redis|pg
MATRIX=(
  "node14.21.3|v14.21.3|5.9.2|10.8.2|4.5.0|29.7.0|5.5.0|4.7.1|8.20.0"
  "node16.20.2|v16.20.2|6.21.0|10.8.2|4.5.0|29.7.0|5.5.0|4.7.1|8.20.0"
  "node18.19.1|v18.19.1|6.21.0|11.7.5|6.2.2|30.4.2|5.5.0|4.7.1|8.20.0"
  "node20.11.1|v20.11.1|6.21.0|11.7.5|6.2.2|30.4.2|5.5.0|5.12.1|8.20.0"
  "node22.21.1|v22.21.1|7.2.0|11.7.5|6.2.2|30.4.2|5.5.0|5.12.1|8.20.0"
  "node24.16.0|v24.16.0|7.2.0|11.7.5|6.2.2|30.4.2|5.5.0|5.12.1|8.20.0"
)
drop() { node -e "
  const {MongoClient}=require('$REPO/node_modules/mongodb');
  MongoClient.connect('mongodb://$MONGO').then(async c=>{await c.db('$1').dropDatabase();await c.close();});"; }
( cd "$REPO" && npm pack --ignore-scripts --pack-destination "$WORK" >/dev/null 2>&1 ) || exit 2
TGZ="$(ls "$WORK"/josk-*.tgz)"
echo "tarball: $(basename "$TGZ")"
FAIL=0
for row in "${MATRIX[@]}"; do
  IFS='|' read -r label node mdb mocha chai jest cron redis pg <<<"$row"
  [ "$ONLY" != "  " ] && [[ "$ONLY" != *" $label "* ]] && continue
  dir="$WORK/$label"; mkdir -p "$dir"
  ( cd "$REPO" && tar --exclude=node_modules --exclude=.git --exclude=coverage -cf - . ) | tar -xf - -C "$dir"
  ( cd "$dir" && node -e "
    const p=require('./package.json');
    p.devDependencies={mocha:'$mocha',chai:'$chai',jest:'$jest','cron-parser':'$cron',mongodb:'$mdb',redis:'$redis',pg:'$pg',josk5:'npm:josk@5.0.0'};
    delete p.scripts.prepublishOnly;
    require('fs').writeFileSync('package.json',JSON.stringify(p,null,2));" \
    && npm install --no-audit --no-fund --ignore-scripts --engine-strict=false --no-package-lock >install.log 2>&1 ) && inst=OK || inst=FAIL
  echo "=== $label mocha@$mocha chai@$chai jest@$jest mongodb@$mdb install=$inst"
  [ "$inst" = OK ] || { tail -3 "$dir/install.log"; FAIL=1; continue; }
  N="$NVM/$node/bin/node"
  run() { # name, cmd...
    local name="$1"; shift
    ( cd "$dir" && "$@" >"$dir/$name.log" 2>&1 ) && r=PASS || { r=FAIL; FAIL=1; }
    echo "  $name: $r ($(grep -Eo '[0-9]+ passing|Tests: .*' "$dir/$name.log" | tr '\n' ' '))"
  }
  db="josk_${label//./_}_$$_$RANDOM-test"; url="mongodb://$MONGO/$db"
  export MONGO_URL="$url"
  run mongo "$N" node_modules/mocha/bin/mocha.js ./test/npm-mongo.js ./test/mongo-url.test.js ./test/mongo-lock-index.js ./test/mongo-task-index.js
  run guards "$N" node_modules/mocha/bin/mocha.js ./test/adapter-guards.js
  run jest "$N" --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.mjs --coverage=false
  # Types are checked once, on Node 24, by `npm run test:types` (compile-time only; not part of this matrix).
  cat > "$dir/smoke.mjs" <<'JS'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const esm = await import('josk');
const cjs = require('josk');
for (const m of [esm, cjs]) {
  for (const k of ['JoSk', 'MongoAdapter', 'RedisAdapter', 'PostgresAdapter']) {
    if (typeof m[k] !== 'function') throw new Error('missing ' + k);
  }
}
console.log('packed esm+cjs OK');
JS
  mkdir -p "$dir/consumer/node_modules/josk" && tar -xzf "$TGZ" -C "$dir/consumer/node_modules/josk" --strip-components=1 && cp "$dir/smoke.mjs" "$dir/consumer/"
  ( cd "$dir/consumer" && "$N" smoke.mjs >"$dir/packed.log" 2>&1 ) && r=PASS || { r=FAIL; FAIL=1; }
  echo "  packed-import: $r"
  drop "$db"
done
echo "work dir: $WORK"
exit $FAIL
