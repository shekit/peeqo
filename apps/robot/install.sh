#!/usr/bin/env bash
# Sets Peeqo up on its Raspberry Pi (Raspberry Pi OS Lite 64-bit, Bookworm or newer). The deploy command
# (npm run deploy -w @peeqo/robot) copies Peeqo to ~/peeqo and runs this; to run it by hand on the Pi:
#
#   bash ~/peeqo/apps/robot/install.sh
#
# Safe to run again (after an update): it only does what is not done yet, then restarts Peeqo.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ME="$(id -un)"
HOSTNAME_WANTED="${PEEQO_HOSTNAME:-peeqo}"
step() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as the robot's normal user (it uses sudo where it needs to), not as root." >&2
  exit 1
fi

step "System packages"
want=(python3-venv python3-smbus2 python3-spidev python3-gpiozero python3-lgpio alsa-utils cage dnsmasq-base network-manager avahi-daemon curl)
missing=()
for package in "${want[@]}"; do dpkg -s "$package" >/dev/null 2>&1 || missing+=("$package"); done
if [ ${#missing[@]} -gt 0 ]; then
  sudo apt-get update
  sudo apt-get install -y "${missing[@]}"
fi
if ! have chromium && ! have chromium-browser; then
  sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
fi
CHROMIUM="$(command -v chromium || command -v chromium-browser)"

step "Memory"
# A Pi 3 B+ has 1 GB: the face (Chromium), the service (Node) and the wake word (Python) fit, with compressed swap
# in memory for headroom. Raspberry Pi OS usually has swap already; if not, add zram.
if [ -z "$(swapon --noheadings 2>/dev/null)" ]; then
  dpkg -s zram-tools >/dev/null 2>&1 || sudo apt-get install -y zram-tools
  printf 'ALGO=zstd\nPERCENT=50\n' | sudo tee /etc/default/zramswap >/dev/null
  sudo systemctl enable zramswap.service >/dev/null 2>&1 || true
  sudo systemctl restart zramswap.service 2>/dev/null || true
fi
free -h | head -3

step "Node.js 22"
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

step "I2C (servo board) and SPI (LED ring)"
if have raspi-config; then
  sudo raspi-config nonint do_i2c 0
  sudo raspi-config nonint do_spi 0
  if [ "$(hostname)" = "raspberrypi" ]; then
    echo "Naming the robot $HOSTNAME_WANTED (so it is $HOSTNAME_WANTED.local)"
    sudo raspi-config nonint do_hostname "$HOSTNAME_WANTED"
  fi
else
  echo "(no raspi-config: not a Raspberry Pi OS; skipping)"
fi
groups_wanted=()
for group in audio i2c spi gpio video input render; do getent group "$group" >/dev/null && groups_wanted+=("$group"); done
if [ ${#groups_wanted[@]} -gt 0 ]; then sudo usermod -aG "$(IFS=,; echo "${groups_wanted[*]}")" "$ME"; fi

step "Peeqo's software"
cd "$DIR"
npm install --omit=dev --no-audit --no-fund
if [ ! -x packages/wakeword/.venv/bin/python ]; then npm run setup -w @peeqo/wakeword; fi

step "Services"
fill() { sed -e "s|@USER@|$ME|g" -e "s|@DIR@|$DIR|g" -e "s|@CHROMIUM@|$CHROMIUM|g" -e "s|@GROUPS@|${groups_wanted[*]:-}|g" "$1"; }
fill apps/robot/system/peeqo.service | sudo tee /etc/systemd/system/peeqo.service >/dev/null
fill apps/robot/system/peeqo-face.service | sudo tee /etc/systemd/system/peeqo-face.service >/dev/null
fill apps/robot/system/sudoers > /tmp/peeqo-sudoers
sudo visudo -cf /tmp/peeqo-sudoers >/dev/null
sudo install -m 0440 -o root -g root /tmp/peeqo-sudoers /etc/sudoers.d/peeqo
rm -f /tmp/peeqo-sudoers
sudo install -d /etc/NetworkManager/dnsmasq-shared.d
sudo install -m 0644 apps/robot/system/captive-dns.conf /etc/NetworkManager/dnsmasq-shared.d/peeqo-captive.conf
if have systemctl && [ -d /run/systemd/system ]; then
  sudo systemctl daemon-reload
  sudo systemctl enable peeqo.service peeqo-face.service
  sudo systemctl restart peeqo.service peeqo-face.service
else
  echo "(no systemd running here: services installed, not started)"
fi

step "Done"
echo "Peeqo is starting. Open http://$(hostname).local on a phone or laptop on the same Wi-Fi."
echo "If the name changed just now, restart the robot first (sudo reboot)."
