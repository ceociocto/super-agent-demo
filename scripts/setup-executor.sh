#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
context=colima-superagent-demo
image=superagent-worker:local
docker --context "$context" info >/dev/null
docker --context "$context" build --tag "$image" "$project_dir/runtime"
docker --context "$context" image inspect "$image" --format '{{.Id}}'
