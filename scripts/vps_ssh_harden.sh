#!/usr/bin/env bash
# Закрыть вход на VPS по паролю: только ключ, только пользователь victoria.
#
# Заведено 22.10.2026. На сервере с этого дня финансы (решение владельца),
# ключи касс, бэк-офиса и выкладки в Amvera, а боты круглые сутки подбирают
# пароль к root (`PermitRootLogin yes`, сервер отвечал «publickey,password»).
#
# Запуск — владелец, во вкладке, сам вводит пароль sudo:
#     sudo bash scripts/vps_ssh_harden.sh
#
# ⚠️ Текущие соединения не рвутся: sshd перечитывает настройки только для
# новых входов. Прежде чем закрывать окно — проверить вход по ключу с Мака.
#
# Откат (если не пускает — через консоль в панели хостинга):
#     sudo rm /etc/ssh/sshd_config.d/00-hardening.conf && sudo systemctl reload ssh

set -euo pipefail

CONF=/etc/ssh/sshd_config.d/00-hardening.conf
KEYS=/home/victoria/.ssh/authorized_keys

[ "$(id -u)" -eq 0 ] || { echo "✗ Запускать через sudo."; exit 1; }

# Без ключа у victoria вход по ключу — это вход никуда. Проверяем до правки.
if ! grep -qE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2)' "$KEYS" 2>/dev/null; then
  echo "✗ В $KEYS нет ни одного ключа — закрывать пароль нельзя, ничего не меняю."
  exit 1
fi
echo "✓ ключей у victoria: $(grep -cE '^(ssh-ed25519|ssh-rsa|ecdsa-sha2)' "$KEYS")"

BACKUP=/root/ssh-backup-$(date +%Y%m%d-%H%M%S)
cp -a /etc/ssh "$BACKUP"
echo "✓ копия настроек: $BACKUP"

# В sshd побеждает ПЕРВОЕ значение. Файлы из sshd_config.d подключаются
# в начале sshd_config по алфавиту, поэтому «00-» стоит раньше
# 50-cloud-init.conf (там у хостинга PasswordAuthentication yes).
cat >"$CONF" <<'EOF'
# Заведено 22.10.2026, scripts/vps_ssh_harden.sh в проекте «Барвиха Невский».
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers victoria
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
EOF
chmod 644 "$CONF"

if ! sshd -t; then
  rm -f "$CONF"
  echo "✗ sshd нашёл ошибку в настройке — файл убран, ничего не изменилось."
  exit 1
fi

echo "— действующие настройки:"
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|authenticationmethods|allowusers|maxauthtries) '

systemctl reload ssh.service
echo
echo "✓ Готово. Вход по паролю закрыт, root напрямую не пускают."
echo "  Теперь на Маке, В НОВОМ окне Терминала:  ssh victoria@185.224.208.8 exit"
echo "  Если пустило без пароля — всё в порядке. Это окно пока не закрывайте."
