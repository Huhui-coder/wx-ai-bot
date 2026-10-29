#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1 && [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  print '请先安装 Node.js 22.13 或更新版本。'
  read '?按回车关闭…'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci --ignore-scripts --no-audit --no-fund || exit 1
fi
npm start
