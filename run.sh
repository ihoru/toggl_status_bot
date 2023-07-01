#!/bin/bash

DIR=$(dirname $0)
cd "${DIR}" || exit
LOG="${DIR}/logs/run.log"
# shellcheck disable=SC2155
export PATH="$(cat .node_path):$PATH"
export NODE_ENV="production"
node "${DIR}/src/index.js" >"$LOG" 2>&1
