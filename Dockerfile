# syntax=docker/dockerfile:1.7

# Pin both the Node patch release and the multi-platform manifest digest. Dependabot
# updates this reference so releases are reproducible without silently freezing fixes.
FROM node:24.21.0-alpine3.23@sha256:159fe64649038c30f8cc1ec4be3af3a6e93e3648678c31294e2c5058dbeb99f3

ARG VERSION=dev
ARG VCS_REF=unknown
LABEL io.modelcontextprotocol.server.name="io.github.KKazuhaK/anteater-mcp" \
      org.opencontainers.image.title="Anteater MCP" \
      org.opencontainers.image.description="MCP server for UCI course search and registration planning" \
      org.opencontainers.image.url="https://github.com/KKazuhaK/Anteater-MCP" \
      org.opencontainers.image.source="https://github.com/KKazuhaK/Anteater-MCP" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app
COPY --chown=node:node anteater-mcp.mjs LICENSE NOTICE ./

USER node
EXPOSE 8787
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["node", "/app/anteater-mcp.mjs"]
CMD ["--http"]
