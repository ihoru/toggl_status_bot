#!/bin/bash

DIR=$(dirname $0)
cd "${DIR}" || exit

git checkout . &&
git pull &&
npm install &&
supervisorctl restart toggl_status_bot && echo "SUCCESS" || echo "FAIL"
