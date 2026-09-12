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

**Work in progress.** Currently implemented:

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

Planned: `info`, `write`, `bootcore`, `vkp` (see `sieflasher help`).

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
```
