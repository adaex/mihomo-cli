#!/bin/sh
set -e

# mihomo one-shot quickstart script
# Usage:
#   curl -fsSL https://v6.gh-proxy.org/raw.githubusercontent.com/adaex/mihomo-cli/main/quickstart.sh | sh -s -- <subscription_url> [options]
#   curl -fsSL https://raw.githubusercontent.com/adaex/mihomo-cli/main/quickstart.sh | sh -s -- <subscription_url> --direct

MIHOMO_CLI_DIR="${MIHOMO_CLI_DIR:-$HOME/.mihomo-cli}"
MIRROR="https://v6.gh-proxy.org/"
GITHUB_REPO="MetaCubeX/mihomo"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=5"

DIR_KERNEL="$MIHOMO_CLI_DIR/kernel"
DIR_SUBSCRIPTIONS="$MIHOMO_CLI_DIR/subscriptions"
DIR_DATA="$MIHOMO_CLI_DIR/data"
DIR_RUNTIME="$MIHOMO_CLI_DIR/runtime"
BINARY_PATH="$DIR_KERNEL/mihomo"
CONFIG_PATH="$DIR_RUNTIME/config.yaml"
SUB_PATH="$DIR_SUBSCRIPTIONS/quickstart.yaml"

SUBSCRIPTION_URL=""
TUN_MODE=0
FORCE_DOWNLOAD=0
MIHOMO_PID=""

info()  { printf '\033[36m[mihomo]\033[0m %s\n' "$*"; }
die()   { printf '\033[31m[mihomo]\033[0m %s\n' "$*" >&2; exit 1; }

with_mirror() {
    _url="$1"
    if [ -n "$MIRROR" ]; then
        case "$_url" in
            https://github.com/*|https://api.github.com/*)
                printf '%s%s' "$MIRROR" "$_url"
                return
                ;;
        esac
    fi
    printf '%s' "$_url"
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --mirror)
                shift
                [ $# -eq 0 ] && die "--mirror requires a URL argument"
                MIRROR="$1"
                case "$MIRROR" in
                    */) ;;
                    *)  MIRROR="${MIRROR}/" ;;
                esac
                ;;
            --no-mirror|--direct)
                MIRROR=""
                ;;
            --tun)
                TUN_MODE=1
                ;;
            --force)
                FORCE_DOWNLOAD=1
                ;;
            --help|-h)
                usage
                exit 0
                ;;
            -*)
                die "Unknown option: $1"
                ;;
            *)
                if [ -z "$SUBSCRIPTION_URL" ]; then
                    SUBSCRIPTION_URL="$1"
                else
                    die "Unexpected argument: $1"
                fi
                ;;
        esac
        shift
    done

    if [ -z "$SUBSCRIPTION_URL" ]; then
        usage
        exit 1
    fi
}

usage() {
    cat << 'EOF'
Usage: quickstart.sh <subscription_url> [options]

Options:
  --mirror <url>    Use a GitHub mirror (default: https://v6.gh-proxy.org/)
  --no-mirror       Direct access to GitHub (no mirror)
  --direct          Same as --no-mirror
  --tun             Enable TUN mode (requires root)
  --force           Force re-download kernel even if exists
  -h, --help        Show this help

Examples:
  # Default (with mirror, recommended for China)
  curl -fsSL https://v6.gh-proxy.org/raw.githubusercontent.com/adaex/mihomo-cli/main/quickstart.sh | sh -s -- "https://sub.example.com/link"

  # Direct GitHub access
  curl -fsSL https://raw.githubusercontent.com/adaex/mihomo-cli/main/quickstart.sh | sh -s -- "https://sub.example.com/link" --direct

  # TUN mode
  curl -fsSL https://v6.gh-proxy.org/raw.githubusercontent.com/adaex/mihomo-cli/main/quickstart.sh | sh -s -- "https://sub.example.com/link" --tun

Available mirrors: gh-proxy.org, v6.gh-proxy.org, hk.gh-proxy.org, cdn.gh-proxy.org
EOF
}

check_deps() {
    for cmd in curl gzip; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            die "Required command not found: $cmd"
        fi
    done
}

detect_platform() {
    OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
    ARCH="$(uname -m)"

    case "$OS" in
        linux)  PLATFORM="linux" ;;
        darwin) PLATFORM="darwin" ;;
        *)      die "Unsupported OS: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64)   ARCH="amd64" ;;
        aarch64|arm64)  ARCH="arm64" ;;
        *)              die "Unsupported architecture: $ARCH" ;;
    esac

    info "Platform: ${PLATFORM}-${ARCH}"
}

setup_dirs() {
    mkdir -p "$DIR_KERNEL" "$DIR_SUBSCRIPTIONS" "$DIR_DATA" "$DIR_RUNTIME"
}

download_kernel() {
    if [ -x "$BINARY_PATH" ] && [ "$FORCE_DOWNLOAD" -eq 0 ]; then
        info "Kernel already exists, skipping download (use --force to re-download)"
        return 0
    fi

    info "Fetching latest release info..."
    api_url="$(with_mirror "$GITHUB_API")"
    releases_json="$(curl -fsSL --connect-timeout 30 "$api_url")" || die "Failed to fetch release info"

    if command -v jq >/dev/null 2>&1; then
        all_urls="$(printf '%s' "$releases_json" | jq -r '
            [.[] | select(.prerelease==false and (.tag_name | test("alpha|beta|prerelease";"i") | not))][0].assets[]
            | select(.name | test("^mihomo-'"$PLATFORM"'-'"$ARCH"'.*\\.gz$"))
            | .browser_download_url
        ')"
    else
        all_urls="$(printf '%s' "$releases_json" | \
            grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' | \
            sed 's/"browser_download_url"[[:space:]]*:[[:space:]]*"//;s/"$//' | \
            grep "mihomo-${PLATFORM}-${ARCH}" | \
            grep '\.gz$')"
    fi

    download_url="$(printf '%s\n' "$all_urls" | grep -v '\-go' | head -1)"
    if [ -z "$download_url" ]; then
        download_url="$(printf '%s\n' "$all_urls" | head -1)"
    fi

    if [ -z "$download_url" ]; then
        die "No matching kernel asset found for ${PLATFORM}-${ARCH}"
    fi

    asset_name="$(basename "$download_url")"
    mirrored_url="$(with_mirror "$download_url")"
    temp_path="$DIR_KERNEL/$asset_name"

    info "Downloading: $asset_name"
    if [ -n "$MIRROR" ]; then
        info "Mirror: $MIRROR"
    fi

    curl -L --progress-bar --connect-timeout 30 --max-time 300 \
        -o "$temp_path" "$mirrored_url" || die "Kernel download failed"

    info "Extracting..."
    case "$asset_name" in
        *.tar.gz|*.tgz)
            tar -xzf "$temp_path" -C "$DIR_KERNEL"
            rm -f "$temp_path"
            found="$(find "$DIR_KERNEL" -type f -name 'mihomo' 2>/dev/null | head -1)"
            if [ -z "$found" ]; then
                found="$(find "$DIR_KERNEL" -type f -name 'mihomo-*' 2>/dev/null | grep -v '\.gz$' | head -1)"
            fi
            if [ -n "$found" ] && [ "$found" != "$BINARY_PATH" ]; then
                mv "$found" "$BINARY_PATH"
            fi
            ;;
        *.gz)
            gzip -dc "$temp_path" > "$BINARY_PATH"
            rm -f "$temp_path"
            ;;
    esac

    chmod 755 "$BINARY_PATH"

    if [ ! -x "$BINARY_PATH" ]; then
        die "Failed to extract kernel binary"
    fi

    version="$("$BINARY_PATH" -v 2>/dev/null | head -1 || echo "unknown")"
    info "Kernel installed: $version"
}

download_subscription() {
    info "Downloading subscription..."

    curl -fsSL --connect-timeout 30 --max-time 60 \
        -o "$SUB_PATH" "$SUBSCRIPTION_URL" || die "Subscription download failed"

    if [ ! -s "$SUB_PATH" ]; then
        die "Subscription content is empty"
    fi

    info "Subscription saved"
}

generate_config() {
    info "Generating config..."

    cat "$SUB_PATH" > "$CONFIG_PATH"

    cat >> "$CONFIG_PATH" << 'EOF'
mixed-port: 7890
external-controller: 127.0.0.1:9090
EOF

    if [ "$TUN_MODE" -eq 1 ]; then
        cat >> "$CONFIG_PATH" << 'EOF'
tun:
  enable: true
  stack: mixed
  dns-hijack:
    - any:53
    - tcp://any:53
  auto-route: true
  auto-detect-interface: true
  strict-route: true
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
EOF
    fi
}

cleanup() {
    printf '\n'
    info "Shutting down..."
    if [ -n "$MIHOMO_PID" ] && kill -0 "$MIHOMO_PID" 2>/dev/null; then
        if [ "$TUN_MODE" -eq 1 ]; then
            sudo kill "$MIHOMO_PID" 2>/dev/null
        else
            kill "$MIHOMO_PID" 2>/dev/null
        fi
        wait "$MIHOMO_PID" 2>/dev/null || true
    fi
    exit 0
}

run_mihomo() {
    trap cleanup INT TERM

    echo ""
    if [ "$TUN_MODE" -eq 1 ]; then
        info "Starting mihomo in TUN mode (requires root)..."
        sudo "$BINARY_PATH" -d "$DIR_DATA" -f "$CONFIG_PATH" &
    else
        info "Starting mihomo..."
        "$BINARY_PATH" -d "$DIR_DATA" -f "$CONFIG_PATH" &
    fi

    MIHOMO_PID=$!

    sleep 1
    if ! kill -0 "$MIHOMO_PID" 2>/dev/null; then
        die "mihomo exited immediately, check subscription config"
    fi

    info "mihomo running (PID $MIHOMO_PID)"
    info "HTTP proxy:  127.0.0.1:7890"
    info "Controller:  http://127.0.0.1:9090"
    info "Press Ctrl+C to stop"
    echo ""

    wait "$MIHOMO_PID" 2>/dev/null || true
}

main() {
    parse_args "$@"
    check_deps
    detect_platform
    setup_dirs
    download_kernel
    download_subscription
    generate_config
    run_mihomo
}

main "$@"
