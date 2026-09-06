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

# 内核资产的标准版命名形态：mihomo-<platform>-<arch>-vX.Y.Z（可能带 v 前缀）。
# 精确匹配而非黑名单枚举后缀变体（-go/-compatible/-v1/-v2 等全都以版本号结尾，
# 黑名单永远枚举不完，且 -v1 变体会按名称排序挤在标准版之前被选中）。
asset_pattern() {
    printf 'mihomo-%s-%s-v?[0-9]+\\.[0-9]+\\.[0-9]+\\.gz$' "$PLATFORM" "$ARCH"
}

download_kernel() {
    if [ -x "$BINARY_PATH" ] && [ "$FORCE_DOWNLOAD" -eq 0 ]; then
        info "Kernel already exists, skipping download (use --force to re-download)"
        return 0
    fi

    info "Fetching latest release info..."
    api_url="$(with_mirror "$GITHUB_API")"
    releases_json="$(curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 30 -H 'User-Agent: mihomo-quickstart' "$api_url")" || die "Failed to fetch release info"

    if command -v jq >/dev/null 2>&1; then
        all_urls="$(printf '%s' "$releases_json" | jq -r '
            [.[] | select(.prerelease==false and (.tag_name | test("alpha|beta|prerelease";"i") | not))][0].assets[]
            | select(.name | test("^mihomo-'"$PLATFORM"'-'"$ARCH"'.*\\.gz$"))
            | .browser_download_url
        ')" || true
    else
        all_urls="$(printf '%s' "$releases_json" | \
            grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' | \
            sed 's/"browser_download_url"[[:space:]]*:[[:space:]]*"//;s/"$//' | \
            grep -v -i -e 'alpha' -e 'beta' -e 'prerelease' | \
            grep "mihomo-${PLATFORM}-${ARCH}" | \
            grep '\.gz$')" || true
    fi

    # 精确匹配标准版形态；无标准版时回退第一个匹配项（仍能装上可用内核）
    pattern="$(asset_pattern)"
    download_url="$(printf '%s\n' "$all_urls" | grep -E "$pattern" | head -1)" || true
    if [ -z "$download_url" ]; then
        download_url="$(printf '%s\n' "$all_urls" | head -1)" || true
    fi

    if [ -z "$download_url" ]; then
        die "No matching kernel asset found for ${PLATFORM}-${ARCH}"
    fi

    # 来源钉死：产物 URL 必须指向 GitHub（API 可能走镜像，browser_download_url
    # 理论上可被篡改；内核随后以 root 运行，不能让镜像自己指定下载地址）
    case "$download_url" in
        https://github.com/*|https://objects.githubusercontent.com/*|https://release-assets.githubusercontent.com/*) ;;
        *) die "Kernel download URL not in GitHub allowlist: $download_url" ;;
    esac

    asset_name="$(basename "$download_url")"
    mirrored_url="$(with_mirror "$download_url")"
    temp_path="$DIR_KERNEL/$asset_name"

    # API 声明的资产字节数，用于下载后比对完整性（无 checksum 时唯一的完整性信号）。
    # 取不到（无 jq / 字段缺失）则留空，跳过比对——不能因此拒绝下载。
    # 与 kernel.ts 的 asset.size 校验对齐（该处此前只有 CLI 有，脚本漂移了一版）。
    expected_size=""
    if command -v jq >/dev/null 2>&1; then
        expected_size="$(printf '%s' "$releases_json" | jq -r --arg name "$asset_name" '
            [.[] | select(.prerelease==false and (.tag_name | test("alpha|beta|prerelease";"i") | not))][0].assets[]
            | select(.name == $name) | .size
        ' 2>/dev/null | head -1)" || true
        case "$expected_size" in
            ''|*[!0-9]*) expected_size="" ;;
        esac
    fi

    info "Downloading: $asset_name"
    if [ -n "$MIRROR" ]; then
        info "Mirror: $MIRROR"
    fi

    # --proto '=https' / --proto-redir '=https'：-L 默认跟随任意协议重定向，
    # 会降级到明文 http 并落盘。产物随后以 root 运行，全链路强制 https。
    # --max-filesize 防止被喂超大文件撑爆磁盘（同 kernel.ts 的 maxBytes）：
    # 已知资产大小时给 2 倍余量，未知时用固定上限
    if [ -n "$expected_size" ]; then
        max_filesize=$((expected_size * 2 + 1048576))
    else
        max_filesize=536870912
    fi
    curl -L --proto '=https' --proto-redir '=https' --max-filesize "$max_filesize" \
        --progress-bar --connect-timeout 30 --max-time 300 \
        -o "$temp_path" "$mirrored_url" || die "Kernel download failed"

    # 比对 API 声明的资产大小：不匹配说明下载被截断（网络中断留下半个文件）或内容被替换。
    # 强度有限（攻击者可填充到同样字节数），但能挡住截断与不等长的偷换。
    # release 资产不可变，字节数不该有任何偏差，故要求精确相等。
    if [ -n "$expected_size" ]; then
        actual_size="$(wc -c < "$temp_path" | tr -d ' ')"
        if [ "$actual_size" != "$expected_size" ]; then
            rm -f "$temp_path"
            die "Downloaded size mismatch (expected ${expected_size} bytes, got ${actual_size}): download truncated or content replaced. Retry, or try another mirror/--direct."
        fi
    fi

    info "Extracting..."
    case "$asset_name" in
        *.tar.gz|*.tgz)
            # 两道守卫，各用一种列表格式：
            # 1) -tzf 给出干净的条目名 → 查路径穿越（绝对路径 / .. ）
            tar -tzf "$temp_path" > /dev/null 2>&1 || die "tar list failed (corrupt archive?)"
            if tar -tzf "$temp_path" 2>/dev/null | grep -qE '^/|(^|/)\.\./'; then
                die "Archive contains illegal path entries (absolute or .. traversal)"
            fi
            # 2) -tvzf 首列权限串首字符给出条目类型 → 拒绝符号/硬链接成员
            # （symlink 条目名合法，能过路径检查，却会让后续 chmod/执行沿链接作用到任意文件）
            if tar -tvzf "$temp_path" 2>/dev/null | grep -qE '^[lh]'; then
                die "Archive contains symlink/hardlink entries (refused)"
            fi
            tar -xzf "$temp_path" -C "$DIR_KERNEL"
            rm -f "$temp_path"
            found="$(find "$DIR_KERNEL" -maxdepth 2 -type f \( -name 'mihomo' -o -name 'mihomo-*' \) ! -name '*.gz' 2>/dev/null | head -1)"
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

    version="$("$BINARY_PATH" -v 2>/dev/null | head -1)" || true
    info "Kernel installed: ${version:-unknown}"
}

download_subscription() {
    info "Downloading subscription..."

    curl -fsSL --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 60 \
        -o "$SUB_PATH" "$SUBSCRIPTION_URL" || die "Subscription download failed"

    if [ ! -s "$SUB_PATH" ]; then
        die "Subscription content is empty"
    fi

    # 订阅内容校验：必须含 proxies / proxy-groups / proxy-providers 之一，
    # 否则机场返回的配额/错误 JSON 会被当成配置，启动后零节点断网
    if ! grep -qE '(proxies|proxy-groups|proxy-providers)[[:space:]]*:' "$SUB_PATH"; then
        die "Subscription content has no node sources (proxies/proxy-groups/proxy-providers); likely an error or quota JSON"
    fi

    info "Subscription saved"
}

generate_config() {
    info "Generating config..."

    sed -e '/^mixed-port:/d' \
        -e '/^external-controller:/d' \
        -e '/^port:/d' \
        -e '/^socks-port:/d' \
        -e '/^geodata-mode:/d' \
        -e '/^geo-auto-update:/d' \
        -e '/^geo-update-interval:/d' \
        -e '/^geox-url:/,/^[^ ]/{' -e '/^geox-url:/d' -e '/^  /d' -e '}' \
        "$SUB_PATH" > "$CONFIG_PATH"

    cat >> "$CONFIG_PATH" << 'EOF'
mixed-port: 7890
external-controller: 127.0.0.1:9090
geodata-mode: true
geo-auto-update: true
geo-update-interval: 24
geox-url:
  geoip: https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip-lite.dat
  geosite: https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite-lite.dat
  mmdb: https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country-lite.mmdb
  asn: https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb
EOF

    if [ "$TUN_MODE" -eq 1 ]; then
        if ! grep -q '^tun:' "$CONFIG_PATH"; then
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
EOF
        else
            sed -i.bak -e '/^tun:/,/^[^ ]/{' -e 's/^\(  enable:\).*/\1 true/' -e '}' "$CONFIG_PATH"
            rm -f "${CONFIG_PATH}.bak"
        fi
        if ! grep -q '^dns:' "$CONFIG_PATH"; then
            cat >> "$CONFIG_PATH" << 'EOF'
dns:
  enable: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
EOF
        fi
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
