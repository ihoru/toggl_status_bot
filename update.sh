#!/bin/bash

DIR=$(dirname $0)
cd "${DIR}" || exit

git checkout . &&
git pull &&
npm install &&
supervisorctrl restart toggl_status_bot && echo "SUCCESS" || echo "FAIL"
