# T9EditorLIT — Go cloud worker daemon
#
# Windows note: the developer machine is an i3 / 8 GB box. `make build` here is
# cheap (the daemon has zero third-party dependencies), but the Windows installer
# for the desktop app is built by GitHub Actions, never here.

BINARY  := t9cloud
CMD     := ./cmd/t9cloud
BIN_DIR := bin
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X github.com/engrtarun/T9EditorLIT/go/internal/api.Version=$(VERSION)

.PHONY: help
help:
	@echo "t9cloud — Go cloud worker daemon"
	@echo ""
	@echo "  make run        run the daemon"
	@echo "  make dev        run with debug logging"
	@echo "  make build      compile to bin/$(BINARY)"
	@echo "  make test       run the test suite"
	@echo "  make race       run tests with the race detector"
	@echo "  make cover      produce coverage.out"
	@echo "  make lint       gofmt check + go vet"
	@echo "  make fmt        apply gofmt"
	@echo "  make check      fmt + vet + test + race (what CI runs)"
	@echo "  make docker     build the container image"

.PHONY: run
run:
	go run $(CMD)

.PHONY: dev
dev:
	go run $(CMD) -log-level debug

.PHONY: build
build:
	go build -trimpath -ldflags "$(LDFLAGS)" -o $(BIN_DIR)/$(BINARY) $(CMD)

.PHONY: test
test:
	go test ./...

# The race detector needs cgo, which needs a C compiler. Windows dev boxes often
# have none, so skip rather than fail — CI runners always do.
.PHONY: race
race:
	@if [ "$(go env CGO_ENABLED)" != "1" ]; then \
		echo "cgo disabled — skipping the race detector (CI runs it)"; \
		exit 0; \
	fi
	go test -race ./...

.PHONY: cover
cover:
	go test -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out

# fmt fails the build if anything is unformatted, so CI catches drift.
.PHONY: lint
lint:
	@unformatted=$$(gofmt -l . 2>/dev/null); \
	if [ -n "$$unformatted" ]; then \
		echo "gofmt needed on:"; echo "$$unformatted"; exit 1; \
	fi
	go vet ./...

.PHONY: fmt
fmt:
	gofmt -w .

.PHONY: check
check: lint test race

.PHONY: docker
docker:
	docker build -t t9cloud:$(VERSION) .