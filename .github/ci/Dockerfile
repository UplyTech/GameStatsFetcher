# One image with both toolchains, for the jobs that compare the two editions
# (parity, surface, packaging). Built on the runner, never pushed anywhere.
# Dependabot watches the FROM lines; the Node binary and npm are taken from the
# official Node image rather than installed from a script off the internet.
#
# The image runs as an unprivileged user (Sonar docker:S6471). uid 1001 is the
# GitHub runner's own user, so files written into the bind-mounted work tree
# stay owned by the runner. Python packages go into a venv that user owns
# instead of the system site-packages.
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS node
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && useradd --uid 1001 --create-home --shell /bin/bash ci \
 && python -m venv /opt/venv \
 && chown -R ci:ci /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    VIRTUAL_ENV=/opt/venv
USER ci
