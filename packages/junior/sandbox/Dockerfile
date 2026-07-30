ARG AMAZON_LINUX_IMAGE=public.ecr.aws/amazonlinux/amazonlinux:2023
FROM ${AMAZON_LINUX_IMAGE}

RUN dnf install -y \
      ca-certificates \
      git \
      gzip \
      nodejs22 \
      nodejs22-npm \
      shadow-utils \
      sudo \
      tar \
    && dnf clean all

ARG RIPGREP_VERSION=15.1.0
ARG RIPGREP_SHA256=1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599
RUN curl -fsSL \
      "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      -o /tmp/ripgrep.tar.gz \
    && printf '%s  %s\n' "${RIPGREP_SHA256}" /tmp/ripgrep.tar.gz | sha256sum -c - \
    && tar -xzf /tmp/ripgrep.tar.gz -C /tmp \
    && install -m 0755 \
      "/tmp/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg" \
      /usr/local/bin/rg \
    && rm -rf /tmp/ripgrep.tar.gz \
      "/tmp/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl"

RUN useradd --create-home --shell /bin/bash vercel-sandbox \
    && install -d -o vercel-sandbox -g vercel-sandbox \
      /vercel/sandbox \
      /vercel/sandbox/.junior \
      /vercel/sandbox/.junior/bin \
    && printf 'vercel-sandbox ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/vercel-sandbox \
    && chmod 0440 /etc/sudoers.d/vercel-sandbox

ENV HOME=/home/vercel-sandbox
ENV PATH=/vercel/sandbox/.junior/bin:${PATH}
WORKDIR /vercel/sandbox

COPY install-runtime-profile.mjs runtime-profile.json /tmp/

USER vercel-sandbox
RUN node /tmp/install-runtime-profile.mjs /tmp/runtime-profile.json \
    && sudo rm /tmp/install-runtime-profile.mjs /tmp/runtime-profile.json

CMD ["/bin/bash"]
