# e2e tests

Runs the `sie-flasher` CLI against a real (emulated) phone:
[pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu) — the
PMB887x hardware emulator — is built and started directly on the host with a
fullflash from
[fullflashes](https://git.siepatch.dev/siepatch/fullflashes), and its phone
serial port is exposed on a local TCP port (the QEMU serial chardev). No
Docker is needed.

## Running

```
pnpm build      # the CLI must be built
pnpm test:e2e   # from the monorepo root (or: pnpm --filter @sie-js/flasher-e2e run e2e)
```

Options (`--key=value` or `E2E_*` env variables):

| Option | Default | Description |
| --- | --- | --- |
| `--device` | `siemens-el71` | the emulator device |
| `--fullflash` | `EL71v41lg91.bin` | the fullflash (a file of the fullflashes repo) |
| `--serial-port` | `4444` | the local TCP port of the phone serial port |
| `--keep-emu` | off | keep the emulator running after the test |

The first run:

* clones the fullflash dumps into `e2e/fullflashes` (gitignored, ~300 MB),
* builds pmb887x-emu into `e2e/.emu` (gitignored; the build dependencies are
  installed automatically with `sudo apt-get` on Debian/Ubuntu, see
  `scripts/setup-emu.sh`).

## What is tested

* the emulator starts and its serial port opens on TCP,
* the CLI runs against the built-in drivers (`vkd-dump`).

TODO: a real flasher session over the TCP transport (boot the emulated
phone, read the flash info) once the transport commands are implemented in
the CLI.
