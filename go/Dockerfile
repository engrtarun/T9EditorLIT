# T9EditorLIT — Go cloud worker daemon
#
# Zero third-party Go dependencies, so the image needs no module download and
# builds in a cold, network-restricted environment. Two stages keep the final
# image small enough to pull on a metered connection.

# ── Build ────────────────────────────────────────────────────────────────
FROM golang:1.23-alpine AS build

WORKDIR /src

# go.mod is copied on its own so this layer caches until dependencies actually
# change, not on every source edit. (There are no requires yet, but the layer
# still pays off the moment one is added.)
COPY go.mod ./
RUN go mod download

COPY . .

ARG VERSION=docker
RUN CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags "-s -w -X github.com/engrtarun/T9EditorLIT/go/internal/api.Version=${VERSION}" \
      -o /out/t9cloud ./cmd/t9cloud

# Fail the build rather than ship a binary that cannot run.
RUN /out/t9cloud -version

# ── Runtime ──────────────────────────────────────────────────────────────
FROM alpine:3.20

# ca-certificates is required for outbound TLS to Groq, Gemini and Telegram.
# wget backs the container HEALTHCHECK below.
RUN apk add --no-cache ca-certificates wget \
 && addgroup -S t9 && adduser -S -G t9 t9

COPY --from=build /out/t9cloud /usr/local/bin/t9cloud

# Holds the MTProto session. Mount a volume here or the session is lost on
# every container restart, which means an OTP prompt on every restart.
RUN mkdir -p /var/lib/t9editor/telegram && chown -R t9:t9 /var/lib/t9editor
ENV T9CLOUD_SESSION_DIR=/var/lib/t9editor/telegram

USER t9
WORKDIR /app

# Loopback only. The daemon holds cloud API keys and has no authentication, so
# it must never be published on a network interface. If you containerise this,
# use `docker run` without -p, or publish to 127.0.0.1 explicitly.
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz > /dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/t9cloud"]
CMD ["-env", "/app/.env"]