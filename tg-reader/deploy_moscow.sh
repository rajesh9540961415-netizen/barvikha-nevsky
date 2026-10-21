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
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

ветка=${1:-work}
индекс=$(mktemp -u)
trap 'rm -f "$индекс"' EXIT
export GIT_INDEX_FILE="$индекс"

git read-tree "$ветка:tg-reader"
git read-tree --prefix=scripts/ "$ветка:scripts"
git read-tree --prefix=mini-app/src/data/ "$ветка:mini-app/src/data"
for файл in "mini-app/src/lib/split.ts" "data/кальяны-категории.json"; do
  git update-index --add --cacheinfo "100644,$(git rev-parse "$ветка:$файл"),$файл"
done

дерево=$(git write-tree)
git fetch -q amvera-reader
git commit-tree "$дерево" -p amvera-reader/master \
  -m "Робот: $(git log -1 --format=%s "$ветка") ($(git rev-parse --short "$ветка"))"
