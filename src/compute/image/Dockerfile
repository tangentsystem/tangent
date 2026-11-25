# Tangent Systems machine image with a headless browser ("browser" image).
# The agent's Chromium runs INSIDE the machine container built from this image,
# under the same limits, user and network namespace as the rest of the machine.
#
# Base pinned by digest; Chromium pinned by Alpine package version. Alpine drops old
# package versions from its mirrors after updates, so a later build may need the
# CHROMIUM_VERSION build arg bumped (see docs/compute.md).
ARG BASE=alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
FROM ${BASE}
ARG CHROMIUM_VERSION=158.0.8127.36-r0
ARG FONT_VERSION=2.37-r6
# Optional: a CA bundle for builds behind a TLS intercepting proxy. It is mounted only
# for this step (BuildKit secret) and never written into the image.
RUN --mount=type=secret,id=build_ca,required=false \
    sh -c 'if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; fi; \
      apk add --no-cache "chromium=${CHROMIUM_VERSION}" "font-dejavu=${FONT_VERSION}"' \
 && rm -rf /var/cache/apk/* \
 && /usr/lib/chromium/chromium --version
LABEL tangent.compute.image="browser" tangent.compute.chromium="/usr/lib/chromium/chromium"
USER 1000:1000
WORKDIR /work
