#!/bin/bash
# Builds pmb887x-emu (the PMB887x Siemens phone emulator) directly on the
# host for the e2e tests. The source tree is cloned into tests/.emu
# (gitignored) and the binary lands in tests/.emu/build-<machine>/pmb887x-emu.
#
# The build directory carries the distribution and the architecture in its
# name because the checkout is often shared between machines (a container
# and its host, a network share): a QEMU linked against the libraries of one
# of them does not start on the other ("libaio.so.1t64: cannot open shared
# object file"), so each gets its own build next to the shared sources.
#
# The build dependencies follow the QEMU configure flags of the emulator
# (gtk, pixman, capstone, smartcard, udev, pulseaudio, aio, io_uring,
# xkbcommon). Debian/Ubuntu and Arch/Manjaro are supported out of the box
# (missing packages are installed with sudo); on other systems install the
# equivalents manually and re-run.
set -euo pipefail

EMU_DIR="$(cd "$(dirname "$0")/.." && pwd)/.emu"
EMU_REPO="${EMU_REPO:-https://github.com/siemens-mobile-hacks/pmb887x-emu}"

machine_tag() {
	local id="" version=""
	if [[ -r /etc/os-release ]]; then
		id="$(. /etc/os-release; echo "${ID:-}")"
		version="$(. /etc/os-release; echo "${VERSION_ID:-}")"
	fi
	local tag="${id:-$(uname -s)}${version:+-$version}-$(uname -m)"
	echo "${tag//[^A-Za-z0-9._-]/-}"
}

# A build is only usable when its binaries actually start on this machine.
build_works() {
	local dir="$1"
	[[ -x "$dir/pmb887x-emu" && -x "$dir/qemu-install/bin/qemu-system-arm" ]] || return 1
	"$dir/pmb887x-emu" --version >/dev/null 2>&1 || return 1
	"$dir/qemu-install/bin/qemu-system-arm" --version >/dev/null 2>&1 || return 1
}

BUILD_DIR="$EMU_DIR/build-$(machine_tag)"

for dir in "$BUILD_DIR" "$EMU_DIR/build"; do
	if build_works "$dir"; then
		echo "pmb887x-emu is already built: $dir/pmb887x-emu"
		exit 0
	fi
done

if [[ -e "$EMU_DIR/build/pmb887x-emu" ]]; then
	echo "$EMU_DIR/build was built elsewhere and does not run here, building $BUILD_DIR"
fi

APT_PACKAGES=(
	build-essential cmake git python3 python3-venv ninja-build meson pkg-config flex bison gettext
	libglib2.0-dev libpixman-1-dev libcapstone-dev libcacard-dev
	libgtk-3-dev libudev-dev libpulse-dev libaio-dev liburing-dev libxkbcommon-dev
	xvfb
)
PACMAN_PACKAGES=(
	base-devel cmake git python ninja meson pkgconf flex bison gettext
	glib2 glib2-devel pixman capstone libcacard
	gtk3 systemd-libs libpulse libaio liburing libxkbcommon
	xorg-server-xvfb
)

if command -v apt-get >/dev/null 2>&1; then
	missing=()
	for pkg in "${APT_PACKAGES[@]}"; do
		dpkg -s "$pkg" >/dev/null 2>&1 || missing+=("$pkg")
	done
	if (( ${#missing[@]} > 0 )); then
		echo "Installing build dependencies: ${missing[*]}"
		sudo apt-get update -qq
		sudo apt-get install -y -qq "${missing[@]}"
	fi
elif command -v pacman >/dev/null 2>&1; then
	missing=()
	for pkg in "${PACMAN_PACKAGES[@]}"; do
		pacman -Qq "$pkg" >/dev/null 2>&1 && continue
		# -Sg covers the groups (base-devel, never a package itself), and a
		# name that is in neither is one this distribution does not have
		# (glib2-devel only exists where glib2 is split); pacman refuses the
		# whole transaction over a single unknown target.
		pacman -Si "$pkg" >/dev/null 2>&1 || pacman -Sg "$pkg" >/dev/null 2>&1 || continue
		missing+=("$pkg")
	done
	if (( ${#missing[@]} > 0 )); then
		echo "Installing build dependencies: ${missing[*]}"
		sudo pacman -S --needed "${missing[@]}"
	fi
else
	echo "no supported package manager found, make sure these are installed: ${APT_PACKAGES[*]}"
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

# tools/build.sh of the emulator always builds into .emu/build; the same
# steps with the machine-specific directory instead.
cd "$EMU_DIR"
cmake -B "$BUILD_DIR"
cmake --build "$BUILD_DIR" -j"$(nproc)"

build_works "$BUILD_DIR" || {
	echo "the build finished but $BUILD_DIR/pmb887x-emu does not start" >&2
	exit 1
}
echo "pmb887x-emu is built: $BUILD_DIR/pmb887x-emu"
