#!/bin/bash

DIR=$(dirname $0)
cd "${DIR}" || exit
LOG="${DIR}/logs/run.log"
export NODE_ENV="production"
npm run start:prod >"$LOG" 2>&1
