# Hardened execution image for CodeTogether Phase 7.
#
# Build from the repository root:
#   docker build -t codetogether-executor:latest execution-sandbox
#
# The container is always started by the API with:
#   --network none --read-only --user 10001:10001 --cap-drop ALL
#   --security-opt no-new-privileges --pids-limit ... --memory ... --cpus ...
#   --tmpfs /tmp (noexec) --tmpfs /work (exec, compiled binaries) --pull never
#
# No host directory, environment variable or Docker socket is passed in.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        gcc \
        g++ \
        openjdk-17-jdk-headless \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# TypeScript/TSX is transpiled and executed with tsx. Type checking is not
# performed because user projects do not have their own dependencies installed.
RUN npm install --global tsx@4.19.2 \
    && npm cache clean --force

# Fixed non-root identity expected by the API's --user flag.
RUN groupadd --gid 10001 sandbox \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin sandbox

COPY run-code /usr/local/bin/run-code
RUN chmod 0755 /usr/local/bin/run-code

USER 10001:10001
WORKDIR /tmp

ENTRYPOINT ["/usr/local/bin/run-code"]
