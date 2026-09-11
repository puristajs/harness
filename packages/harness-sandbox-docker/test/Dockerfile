# The operator supplies an already-pinned Debian image containing coreutils/findutils.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER 0:0
RUN mkdir -p /workspace /skills && chown 1000:1000 /workspace /skills
USER 1000:1000
WORKDIR /workspace
