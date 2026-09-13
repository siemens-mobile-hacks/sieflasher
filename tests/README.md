# e2e tests

Runs the `sieflasher` CLI against real (emulated) phones:
[pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu) — the
PMB887x hardware emulator — is built and started directly on the host with a
fullflash from the
[fullflashes](https://git.siepatch.dev/siepatch/fullflashes) submodule, and
its phone serial port is exposed on a local TCP port (the QEMU serial
chardev). No Docker is needed.

The patch tests additionally use the real community patches of the
[patches](https://github.com/siemens-mobile-hacks/patches) submodule
(`tests/patches`).

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
| `--smoke` | off | the quick matrix: every test that runs under a minute per test — the per-speed 512 KiB reads/writes, the sub-page writes, all file patches, one patch round trip and the recovery test per phone — leaving out only the whole-fullflash tests and the other serial patches; a few minutes instead of ~1 h (also `pnpm test:e2e:smoke` from the root, or `E2E_SMOKE=1`) |
| `--update-patch-status` | off | rewrite `patches-status.json` from the results instead of failing on a changed patch status |

The first run builds pmb887x-emu into `tests/.emu` (gitignored; the build
dependencies are installed automatically with `sudo apt-get` on
Debian/Ubuntu, see `scripts/setup-emu.sh`).

## The test matrix

Every test starts its own emulator instance (its own TCP port, fully
isolated) and runs a real flasher session over the emulator's serial port:
the phone is booted into service mode, the loader is uploaded, and the flash
is read with `sieflasher read` / written with `sieflasher write` / patched
with `sieflasher apply` and `sieflasher revert`. The exception are the
`patch-file:` tests, which apply their patch to a copy of the fullflash as a
file (`sieflasher apply --file`) and need no emulator at all.

The patch tests apply the real community patches of the `patches` submodule
(see below). The read tests read 512 KiB at every speed and the whole fullflash at the
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
and write at the maximum speed. A 512 KiB test takes ~10–80 s, a fullflash
read a few minutes and a fullflash write ~an hour; `--smoke` (below) drops
only the whole-fullflash tests.

### The patch tests

Every patch of the firmware of the fullflash (`tests/patches/patches/EL71v41`,
`tests/patches/patches/S75v40`) is applied to its own fresh copy of that
fullflash and verified afterwards, byte for byte, against the copy the
emulator persisted (or against the patched file):

* `patch-file:<firmware>/<patch>` — **every** patch, applied to a copy of the
  fullflash as a file (`--file`), which takes a few seconds, and reverted
  again: the copy must be back at the original fullflash byte for byte.
* `patch:<firmware>/<patch>` — a real flasher session over the serial port,
  on top of the file test. Only the **10 most unusual** patches per phone run
  this way (the ranking weighs the number of writes, the written bytes, how
  many erase blocks they touch, writes without old data and non-default
  pragmas — the patches that exercise the most of the flasher), because every
  one of them costs an emulator boot and a real flash erase cycle.

One patch per phone (the most unusual one) is additionally **undone** over the
serial port in a second emulator session and must restore the fullflash. This
is the `--smoke` patch test.

`patch-recovery:<firmware>/<patch>` — one per phone — takes a patch that does
*not* apply cleanly and forces it through over the serial port with `--yes`:
the CLI must save a **recovery patch** before the first write, and undoing
that recovery patch must restore the fullflash byte for byte (the V_KLay
repair patch flow on a real phone). The patch is picked from the fullflash
itself (the runner knows which patches its data does not match); when every
patch of the firmware applies cleanly, as for EL71v41, a patch of another
firmware version of the same model is used — applying one of those is exactly
the situation the recovery patch exists for.

A patch that does not apply cleanly is not a failure: its old data may simply
not be in this fullflash, or it may not even parse. Such a patch must leave
the flash **untouched**, and its status (`dirty`, `invalid`, `outside`,
`noop`) is tracked per firmware in [`patches-status.json`](patches-status.json).
A patch whose status changed — one that stopped applying cleanly, or one that
now applies although it is tracked as broken — fails its test; rerun with
`--update-patch-status` to record the new state:

```
node run-e2e.mjs --only=patch --update-patch-status
```

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
