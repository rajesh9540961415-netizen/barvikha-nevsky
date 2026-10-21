#!/usr/bin/env bash
# Собирает коммит для МОСКОВСКОГО робота (`chaevye-reader`) из ветки work.
#
# Зачем отдельный скрипт. С 21.10.2026 московский робот собирает утренний отчёт
# по чаевым (report_job.py) — а это скрипты из `scripts/` и справочники
# приложения смены. В корне робота их нет: Amvera собирает то, что ей прислали,
# и ничего за пределами присланного дерева не видит. Поэтому дерево собирается
# здесь: робот в корне, рядом — то, что нужно скриптам, по тем же путям, что
# в проекте (скрипты ищут файлы относительно своей папки).
#
# Варшавскому роботу всё это не нужно — он по-прежнему получает только tg-reader.
#
# Только печатает номер коммита, ничего не отправляет. Выкладка — отдельно:
#   C=$(tg-reader/deploy_moscow.sh) && git push amvera-reader "$C":refs/heads/master
# ⚠️ Имена переменных — латиницей: bash русских не понимает (наступали 20.10 и 21.10).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BRANCH=${1:-work}
INDEX=$(mktemp -u)
trap 'rm -f "$INDEX"' EXIT
export GIT_INDEX_FILE="$INDEX"

git read-tree "$BRANCH:tg-reader"
git read-tree --prefix=scripts/ "$BRANCH:scripts"
git read-tree --prefix=mini-app/src/data/ "$BRANCH:mini-app/src/data"
for FILE in "mini-app/src/lib/split.ts" "data/кальяны-категории.json" "data/столы-рестоплейс.json"; do
  git update-index --add --cacheinfo "100644,$(git rev-parse "$BRANCH:$FILE"),$FILE"
done

TREE=$(git write-tree)
git fetch -q amvera-reader
git commit-tree "$TREE" -p amvera-reader/master \
  -m "Робот: $(git log -1 --format=%s "$BRANCH") ($(git rev-parse --short "$BRANCH"))"
