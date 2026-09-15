# Reviewed 2026-08-31. Update the digest deliberately and rerun the image tests.
FROM node:24-alpine3.23@sha256:0388af2af070cd4736a1567cfed02469ba117848845b4165d87a333edb53d2ca AS prepared

# BusyBox find/stat/grep do not implement the adapter's GNU command contract.
RUN apk add --no-cache coreutils findutils grep \
    && mkdir -p /workspace /skills \
    && chown 1000:1000 /workspace /skills \
    && chmod 0750 /workspace /skills \
    && rm -rf /usr/local/lib/node_modules /usr/local/include/node /opt/yarn-* \
        /usr/share/man /usr/share/doc \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh \
        /sbin/apk \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

# Flatten the prepared rootfs: removed package managers/headers must not survive
# in lower layers. Retain OS package metadata and licenses for vulnerability scans.
FROM scratch
COPY --from=prepared / /
LABEL org.opencontainers.image.title="PURISTA minimal sandbox" \
      org.opencontainers.image.description="Credential-free Node.js and GNU utilities for Harness sandbox adapters" \
      org.opencontainers.image.source="https://github.com/puristajs/harness"
ENV PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    LANG="C.UTF-8"
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
