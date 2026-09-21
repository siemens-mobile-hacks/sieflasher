# @sie-js/flasher-cli

The `sieflasher` command line tool — the terminal frontend of the
[@sie-js/flasher](../core) library.

## Running

The CLI is not published to npm; build it from the repository:

```
git clone --recurse-submodules <url> sieflasher
cd sieflasher
pnpm install
pnpm build
```

### Install as a global binary

Install the `sieflasher` command onto your PATH with a pnpm global install
(run it once beforehand if pnpm complains about the global bin directory):

```
pnpm setup
pnpm add --global ./cli
```

After this `sieflasher <command>` works from anywhere. The global install
links to this repository checkout, not a copy: `pnpm build` in the repo
updates the installed command, so keep the checkout around. Remove it with
`pnpm remove --global @sie-js/flasher-cli`.

### Running from the repository

Without a global install, run the tool through its entry point (from the
repository root):

```
node cli/dist/index.js <command>
```

`cli/dist/index.js` is executable and starts with a `#!/usr/bin/env node`
shebang, so `./cli/dist/index.js <command>` works too. For a persistent
`sieflasher` command without a pnpm global install, add a shell alias:

```
alias sieflasher="node /path/to/sieflasher/cli/dist/index.js"
```

Note: `pnpm --filter @sie-js/flasher-cli exec sieflasher` does **not** work —
pnpm only links the bins of a package's dependencies, not the package's own
`bin`, so the `sieflasher` executable is not on the exec PATH.

The built-in `.vkd` drivers live in the [vklay-loaders](../loaders) package:
pass e.g. `loaders/x65.vkd` (relative to the repository root) as `--loader`.

## Commands

**Work in progress.** Currently implemented (planned: `info`, `bootcore`,
see `sieflasher help`):

* `sieflasher vkd-dump <file.vkd>` — parse a V_KLay phone driver and dump
  its phones, memory areas, flash geometry and boot sequence.
* `sieflasher read` — boot a phone over a serial transport and read its
  flash memory into a file:

```
sieflasher read --serial <device> --loader <file.vkd> [--phone <name>] \
    [--base_addr <hex>] [--length <size>] [--baud <rate>] <output.bin>
```

| Option | Description |
| --- | --- |
| `--serial` | required: a serial device (`/dev/ttyUSB0`, `COM3`) or a socket for the pmb887x-emu emulator (`tcp://127.0.0.1:4444`, `unix:/path/to/sock`) |
| `--loader` | required: the V_KLay phone driver (`.vkd`) |
| `--phone` | the phone definition of the loader (by name; default: the first) |
| `--base_addr` | the flash offset to start from (default: `0`) |
| `--length` | how many bytes to read (default: to the end of the fullflash; accepts `512K`, `4M`, `0x80000`) |
| `--baud` | the loader connection speed (default: 115200) |

* `sieflasher write` — write a file (a fullflash dump or a part of it) into
  the phone flash memory; the same options as `read`.
* `sieflasher apply` / `sieflasher revert` — apply a VKP patch to a phone or
  to a fullflash dump file, and undo it again:

```
sieflasher apply  [options] [patch.vkp]
sieflasher revert [options] [patch.vkp]
```

| Option | Description |
| --- | --- |
| `<patch.vkp>` | the patch; without it (or with `-`) the patch is read from stdin |
| `--serial` | the serial port of the phone (see `read`) |
| `--loader` | the V_KLay phone driver (`.vkd`), required with `--serial` |
| `--phone` | the phone definition of the loader (by name; default: the first) |
| `--baud` | the loader connection speed (default: 115200) |
| `--file` | patch a fullflash dump file in place instead of a phone (an alternative to `--serial`) |
| `--base_addr` | with `--file`: the flash address the dump starts at (default: its `_From_XX` file name suffix, or `0`) |
| `--dry-run` | only check whether the patch applies / reverts, write nothing |
| `--yes` | answer the warnings with yes (for non-interactive use) |
| `--force` | write even when the data does not match, without asking and without saving a recovery patch |
| `--no-history` | do not log the run into the patch history |

Patch addresses are the V_KLay flash offsets (`0x00A165E8` is the CPU address
`0xA0A165E8` on x65) and are used as they are. A patch reaching outside of the
flash — or, with `--file`, outside of the dump — is rejected before anything is
written.

### The patch history and the recovery patches

Every real (not `--dry-run`) apply and revert is logged into
`~/.sieflasher/history` — the analog of V_KLay's patch logging and of the
History tab of the [web tools](https://siemens-mobile-hacks.github.io/):

```
~/.sieflasher/history/2026-09/2026-09-13_12-30-01_apply_SIEMENS_EL71_490154203237518_mypatch.vkp
~/.sieflasher/history/2026-09/2026-09-13_12-30-01_apply_SIEMENS_EL71_490154203237518_mypatch.json
```

The `.vkp` is the patch text as it was applied, the `.json` sidecar holds the
date, the action, the device (model, IMEI, the unique device name and the
flash info), the patch name and title, the number of writes, the written
bytes, the result (`ok`, `partial`, `cancelled`) and the recovery patch, when
one was saved. Nothing is deleted automatically. The root is
`%APPDATA%\sieflasher` on Windows and can be overridden with the
`SIEFLASHER_HOME` environment variable.

When a patch does not apply (or revert) cleanly — its old data is not in the
flash, or it has no old data at all, so the undo would be impossible — the
CLI prints the V_KLay warning and asks whether to continue. On a yes it
saves a **recovery patch** into `~/.sieflasher/recovery` *before* writing
anything and prints its path: applying it back with `sieflasher revert`
restores the original flash contents.

```
$ sieflasher apply --serial /dev/ttyUSB0 --loader loaders/x65.vkd mypatch.vkp
! WARNING: the old data of 1 of 3 block(s) of the patch is not found in the flash.
! First mismatch at 0xA05BF92B (patch line 12): the flash has 00, the patch expects D1.
! ...
! [y/N] y
recovery patch saved: ~/.sieflasher/recovery/2026-09-13_12-30-01_mypatch_REPAIR.vkp
```

Without a terminal to ask on (a script, a pipe) the warnings are declined and
nothing is written; `--yes` confirms them instead (the recovery patch is
still saved), `--force` skips both the questions and the recovery patch.

The serial transport is built on
[@sie-js/serial](https://github.com/siemens-mobile-hacks/node-sie-serial)
(a CLI/tests-only dependency; the core library stays transport-agnostic).
The emulator wiring is exercised by the [e2e tests](../tests).

## Examples

With the global binary installed (or substitute `node cli/dist/index.js`):

```
$ sieflasher vkd-dump loaders/x65.vkd
loaders/x65.vkd: 10 phone(s), 6 boot(s)
copyright: Chaos, Ported to V_KLay by ValeraVi

Phone01: S65 (Chaos BootPatch)
  fullflash: 0xA0000000..0xA1FFFFFF (32 MiB)
  ...

$ sieflasher read --serial tcp://127.0.0.1:4444 \
    --loader tests/loaders/emulator.vkd --phone EL71 dump.bin

$ sieflasher apply --serial /dev/ttyUSB0 --loader loaders/x65.vkd \
    --phone EL71 patches/EL71v41/6673-Disable_Aircraft_Check.vkp
patch: 6673-Disable_Aircraft_Check.vkp: 1 write(s), "EL71v41"
phone: SIEMENS EL71, IMEI 490154203237518, flash 0x8819 @ 0xA0000000 (256x256 KiB)
applying 6673-Disable_Aircraft_Check.vkp on /dev/ttyUSB0
  0xA05BF92B      1 B  applied
history: ~/.sieflasher/history/2026-09/2026-09-13_12-30-01_apply_SIEMENS_EL71_490154203237518_6673-Disable_Aircraft_Check.vkp
6673-Disable_Aircraft_Check.vkp: 1 write(s): 1 applied, 0 skipped, 0 failed; 1 B written to /dev/ttyUSB0 in 12.4s

$ sieflasher revert --file S75_2020-01-01_From_A0.bin mypatch.vkp
$ cat mypatch.vkp | sieflasher apply --file dump.bin --dry-run
```
