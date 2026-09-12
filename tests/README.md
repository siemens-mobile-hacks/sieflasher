# e2e tests

Runs the `sieflasher` CLI against real (emulated) phones:
[pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu) — the
PMB887x hardware emulator — is built and started directly on the host with a
fullflash from the
[fullflashes](https://git.siepatch.dev/siepatch/fullflashes) submodule, and
its phone serial port is exposed on a local TCP port (the QEMU serial
chardev). No Docker is needed.

## Running

```
git clone --recurse-submodules <sieflasher url>
pnpm install
pnpm build      # the CLI must be built
pnpm test:e2e   # from the monorepo root (or: pnpm --filter @sie-js/flasher-tests run e2e)
```

Options (`--key=value` or `E2E_*` env variables):

| Option | Default | Description |
| --- | --- | --- |
| `--loader` | `loaders/emulator.vkd` | the phone driver for the emulated phones |
| `--jobs` | one per CPU core | the number of tests running in parallel |
| `--only` | off | run only the tests whose name contains the substring |
| `--keep-emu` | off | keep the emulators running after the tests |
| `--smoke` | off | the quick matrix: every test that runs under a minute per test — the per-speed 512 KiB reads/writes and the sub-page writes, 42 of the 46 tests — leaving out only the whole-fullflash reads and writes; a few minutes instead of ~1 h (also `pnpm test:e2e:smoke` from the root, or `E2E_SMOKE=1`) |

The first run builds pmb887x-emu into `tests/.emu` (gitignored; the build
dependencies are installed automatically with `sudo apt-get` on
Debian/Ubuntu, see `scripts/setup-emu.sh`).

## The test matrix

Every test starts its own emulator instance (its own TCP port, fully
isolated) and runs a real flasher session over the emulator's serial port:
the phone is booted into service mode, the loader is uploaded, and the flash
is read with `sieflasher read` / written with `sieflasher write`.

The read tests read 512 KiB at every speed and the whole fullflash at the
maximum speed; every dump must match the fullflash file byte for byte. The
write tests mirror the per-speed reads (plus an unaligned range inside one
flash block, for the read-modify-write path, and one whole-fullflash write
per phone at the maximum speed): they write a modified copy of the
fullflash range into a private `--rw` flash copy of the emulator, and
after the emulator exits the persisted copy must equal the input written
over the original fullflash, byte for byte, everywhere — not just inside the
written range. (The whole-fullflash write is the long pole of the suite:
~an hour of emulated flash erases per phone, with a 2 h CLI budget.)

| Fullflash | Device | Loader |
| --- | --- | --- |
| `EL71v41lg91.bin` | `siemens-el71` | chaos_x85 (the x85/elka family) |
| `S75v40lg1.bin` | `siemens-s75` | pv_boot_x85 (the x75 family, with the 0x55→0xAA init) |

`KE800v11b.bin` (lg-ke800) is not supported by the loaders yet.

For every fullflash both the read and the write matrix run 512 KiB at **every
speed** the loader supports (57600 … 3250000), plus the whole-fullflash read
and write at the maximum speed, so a full run is 46 tests. A 512 KiB test
takes ~10–80 s, a fullflash read a few minutes and a fullflash write ~an
hour; `--smoke` (below) drops only the whole-fullflash tests.

## The emulator quirks

* The emulator is started with `--wait-for-serial`: the emulated phone stays
  in its boot ROM serial monitor until the first serial byte arrives, so the
  CLI always catches the service mode window (which is short - the AT poll
  stream of the `Connect` boot must start immediately and stay tight).
* After the loader stop at the end of a flasher session the emulated phone
  is dead until a power cycle (which the runner cannot do), so every test
  runs exactly one flasher session per emulator instance and the write tests
  verify against the persisted `--rw` flash copy instead of reading back in
  a second session.
* The boot ROM of the emulated SGOLD2 phones answers the `AT` magic with
  `0xC0` (NewSGOLD) instead of the SGOLD `0xB0`, and accepts the unsigned
  service loaders of the emulator bsp; see `loaders/emulator.vkd`.
* The upstream pmb887x-emu currently pins a bsp revision whose board
  configs reference an unimplemented RF device; `scripts/setup-emu.sh`
  applies the board fix from
  [pmb887x-dev PR #7](https://github.com/siemens-mobile-hacks/pmb887x-dev/pull/7)
  until the pin is updated.
