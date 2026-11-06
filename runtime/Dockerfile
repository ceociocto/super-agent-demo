FROM node:22-alpine
WORKDIR /opt/superagent
COPY worker.mjs query.mjs ./
COPY fixtures ./fixtures
USER 1000:1000
ENTRYPOINT ["node", "/opt/superagent/worker.mjs"]
