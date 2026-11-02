#!/bin/sh
set -eu
repo=Huhui-coder/wx-ai-bot
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' '此安装器用于 macOS；Windows 请使用 install.ps1。' >&2
  exit 1
fi
case "$(uname -m)" in
  arm64) asset=weixin-lite-darwin-arm64 ;;
  x86_64) asset=weixin-lite-darwin-x64 ;;
  *) printf '%s\n' '暂不支持当前处理器。' >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
# Pinned: "latest" belongs to the plain assistant on main.
base="https://github.com/$repo/releases/download/v0.7.0-girlfriend"
printf '%s\n' '正在下载赛博女友…'
curl -fL --retry 3 "$base/$asset" -o "$tmp/$asset"
curl -fsSL --retry 3 "$base/SHA256SUMS" -o "$tmp/SHA256SUMS"
awk -v file="$asset" '$2 == file {print}' "$tmp/SHA256SUMS" > "$tmp/checksum"
[ -s "$tmp/checksum" ] || { printf '%s\n' '发布包缺少校验信息。' >&2; exit 1; }
(cd "$tmp" && shasum -a 256 -c checksum)
dest="$HOME/.local/bin"
mkdir -p "$dest"
# A running service would keep serving the old version after the file is replaced.
if [ -x "$dest/weixin-lite" ] && ! "$dest/weixin-lite" stop; then
  # Newer macOS kills older unsigned builds on launch; such a binary cannot be serving anything.
  if "$dest/weixin-lite" --version >/dev/null 2>&1; then
    printf '%s\n' '旧服务未能停止，未替换程序。' >&2; exit 1
  fi
  printf '%s\n' '旧版程序已无法运行，直接替换。'
fi
cp "$tmp/$asset" "$dest/.weixin-lite-new-$$"
chmod +x "$dest/.weixin-lite-new-$$"
mv -f "$dest/.weixin-lite-new-$$" "$dest/weixin-lite"
printf '已安装。以后运行：%s/weixin-lite\n' "$dest"
"$dest/weixin-lite"
