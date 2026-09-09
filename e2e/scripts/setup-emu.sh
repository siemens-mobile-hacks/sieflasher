#!/bin/bash
# Builds pmb887x-emu (the PMB887x Siemens phone emulator) directly on the
# host for the e2e tests. The source tree is cloned into e2e/.emu
# (gitignored) and the binary lands in e2e/.emu/build/pmb887x-emu.
#
# The build dependencies follow the QEMU configure flags of the emulator
# (gtk, pixman, capstone, smartcard, udev, pulseaudio, aio, io_uring,
# xkbcommon). Debian/Ubuntu is supported out of the box (missing packages
# are installed with sudo apt-get); on other systems install the
# equivalents manually and re-run.
set -euo pipefail

EMU_DIR="$(cd "$(dirname "$0")/.." && pwd)/.emu"
EMU_REPO="${EMU_REPO:-https://github.com/siemens-mobile-hacks/pmb887x-emu}"
EMU_BIN="$EMU_DIR/build/pmb887x-emu"
QEMU_BIN="$EMU_DIR/build/qemu-install/bin/qemu-system-arm"

if [[ -x "$EMU_BIN" && -x "$QEMU_BIN" ]]; then
	echo "pmb887x-emu is already built: $EMU_BIN"
	exit 0
fi

PACKAGES=(
	build-essential cmake git python3 python3-venv ninja-build meson pkg-config flex bison gettext
	libglib2.0-dev libpixman-1-dev libcapstone-dev libcacard-dev
	libgtk-3-dev libudev-dev libpulse-dev libaio-dev liburing-dev libxkbcommon-dev
	xvfb
)

if command -v apt-get >/dev/null 2>&1; then
	missing=()
	for pkg in "${PACKAGES[@]}"; do
		dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
	done
	if (( ${#missing[@]} > 0 )); then
		echo "Installing build dependencies: ${missing[*]}"
		sudo apt-get update -qq
		sudo apt-get install -y -qq "${missing[@]}"
	fi
else
	echo "apt-get not found, make sure these are installed: ${PACKAGES[*]}"
fi

if [[ ! -d "$EMU_DIR/.git" ]]; then
	git clone --recurse-submodules "$EMU_REPO" "$EMU_DIR"
else
	git -C "$EMU_DIR" submodule update --init --recursive
fi

cd "$EMU_DIR"
./tools/build.sh
