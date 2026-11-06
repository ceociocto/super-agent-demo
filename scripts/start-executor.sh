#!/bin/sh
set -eu
exec colima start superagent-demo \
  --cpu 2 --memory 2 --disk 12 \
  --vm-type vz --runtime docker \
  --mount none --activate=false \
  --ssh-agent=false --ssh-config=false --port-forwarder none
