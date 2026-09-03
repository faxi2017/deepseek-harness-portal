FROM node:24-trixie-slim@sha256:0711b541c1c33a8a530ac4f0d391baa9a15b3d804695b1b24a47daa5fb60e74d

ARG DSH_VERSION
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com
RUN test -n "$DSH_VERSION" \
 && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
 && apt-get -o APT::Update::Error-Mode=any update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 build-essential iptables \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g --registry="$NPM_REGISTRY" "@deepseek-ai/dsh@$DSH_VERSION" pnpm@10.28.2 \
 && npm cache clean --force

# Reviewed container-listener patch; drift must fail the build.
COPY patch-dsh.mjs /opt/dsh/patch-dsh.mjs
RUN node /opt/dsh/patch-dsh.mjs
LABEL dsh.portal.version=$DSH_VERSION

RUN usermod -l dsh -d /home/dsh -m node \
 && groupmod -n dsh node \
 && mkdir -p /workspace /home/dsh/.dsh \
 && chown -R dsh:dsh /workspace /home/dsh

COPY start.sh tenant-firewall.sh /opt/dsh/
USER dsh
ENV HOME=/home/dsh DSH_HOME=/home/dsh/.dsh
WORKDIR /workspace
EXPOSE 3000
ENTRYPOINT ["/bin/bash", "/opt/dsh/start.sh"]
