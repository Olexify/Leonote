# The tools a Tauri 2 app needs to be built for Linux. Ubuntu 22.04 on purpose:
# a build made on an older system runs on newer ones, not the other way round.
# BASE lets the build script use a mirror of the very same image when Docker Hub cannot be reached
ARG BASE=ubuntu:22.04
FROM ${BASE}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates pkg-config git rsync xdg-utils \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"
# an AppImage is put together by a tool that is itself an AppImage; there is no FUSE in a container
ENV APPIMAGE_EXTRACT_AND_RUN=1
WORKDIR /build
COPY scripts/linux-build.sh /linux-build.sh
RUN chmod +x /linux-build.sh
CMD ["/linux-build.sh"]
