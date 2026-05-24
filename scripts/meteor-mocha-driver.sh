#!/usr/bin/env bash
# Match meteorTestProfile() mocha pin in package.js (bundled Node major).
set -euo pipefail
major=$(meteor node --version | sed 's/^v//' | cut -d. -f1)
if [ "$major" -ge 18 ]; then
  echo 'meteortesting:mocha@3.3.0'
elif [ "$major" -ge 14 ]; then
  echo 'meteortesting:mocha@2.5.3'
else
  echo 'meteortesting:mocha@1.1.5'
fi
