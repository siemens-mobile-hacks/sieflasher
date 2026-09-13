#!/bin/bash
# Builds pmb887x-emu (the PMB887x Siemens phone emulator) directly on the
# host for the e2e tests. The source tree is cloned into e2e/.emu
# (gitignored) and the binary lands in e2e/.emu/build/pmb887x-emu.
#
# The build dependencies follow the QEMU configure flags of the emulator
# (gtk, pixman, capstone, smartcard, udev, pulseaudio, aio, io_uring,
# xkbcommon); they are named below for Debian/Ubuntu and only reported, not
# installed. An emulator that is already installed or built elsewhere needs
# none of this: run-e2e.mjs --emu=/path/to/pmb887x-emu runs that one
# instead.
set -euo pipefail

EMU_DIR="$(cd "$(dirname "$0")/.." && pwd)/.emu"
EMU_REPO="${EMU_REPO:-https://github.com/siemens-mobile-hacks/pmb887x-emu}"
EMU_BIN="$EMU_DIR/build/pmb887x-emu"
QEMU_BIN="$EMU_DIR/build/qemu-install/bin/qemu-system-arm"

if [[ -x "$EMU_BIN" && -x "$QEMU_BIN" ]]; then
	# Present is not enough: a build carried over from another machine is
	# there but does not start ("libaio.so.1t64: cannot open shared object
	# file"), which otherwise only shows up as every emulator dying later.
	if "$EMU_BIN" --version >/dev/null 2>&1 && "$QEMU_BIN" --version >/dev/null 2>&1; then
		echo "pmb887x-emu is already built: $EMU_BIN"
		exit 0
	fi
	echo "$EMU_BIN exists but does not start here (built on another machine?)." >&2
	echo "Remove $EMU_DIR/build to build it again, or run the tests with --emu=/path/to/pmb887x-emu." >&2
	exit 1
fi

PACKAGES=(
	build-essential cmake git python3 python3-venv ninja-build meson pkg-config flex bison gettext
	libglib2.0-dev libpixman-1-dev libcapstone-dev libcacard-dev
	libgtk-3-dev libudev-dev libpulse-dev libaio-dev liburing-dev libxkbcommon-dev
	xvfb
)

if command -v dpkg >/dev/null 2>&1; then
	missing=()
	for pkg in "${PACKAGES[@]}"; do
		dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
	done
	if (( ${#missing[@]} > 0 )); then
		echo "Install the missing build dependencies first: ${missing[*]}" >&2
		exit 1
	fi
else
	echo "Make sure the build dependencies are installed (Debian/Ubuntu names): ${PACKAGES[*]}"
fi

if [[ ! -d "$EMU_DIR/.git" ]]; then
	git clone --recurse-submodules "$EMU_REPO" "$EMU_DIR"
else
	git -C "$EMU_DIR" submodule update --init --recursive
fi

# The currently pinned bsp submodule references the hd155153np RF device,
# which the pinned QEMU does not implement yet ("Unknown device:
# hd155153np" on the siemens-* boards). Apply the board fix from
# https://github.com/siemens-mobile-hacks/pmb887x-dev/pull/7 until it is
# merged and pmb887x-emu updates the pin.
if grep -rq hd155153np "$EMU_DIR/bsp/lib/data/board/" 2>/dev/null; then
	echo "Applying the bsp board fix (pmb887x-dev PR #7)"
	git -C "$EMU_DIR/bsp" fetch origin refs/pull/7/head
	git -C "$EMU_DIR/bsp" checkout -q FETCH_HEAD
fi

cd "$EMU_DIR"
./tools/build.sh
