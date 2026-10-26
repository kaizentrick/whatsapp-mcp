#!/bin/sh
set -eu
umask 077
if [ "${1:-serve}" = serve ]; then
  node /app/dist/cli.js init >&2
fi
exec node /app/dist/cli.js "$@"
