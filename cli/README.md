# @sie-js/flasher-cli

The `sie-flasher` command line tool — the terminal frontend of the
[@sie-js/flasher](../core) library.

**Work in progress.** Currently implemented:

* `sie-flasher vkd-dump <file.vkd>` — parse a V_KLay phone driver and dump
  its phones, memory areas, flash geometry and boot sequence.

Planned: `info`, `read`, `write`, `bootcore`, `vkp` — booting a real phone
over a serial cable (or the [pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu)
emulator, see the [e2e tests](../e2e)) and reading/writing its flash memory.

```
$ pnpm --filter @sie-js/flasher-cli exec sie-flasher vkd-dump node_modules/vklay-loaders/x65.vkd
node_modules/vklay-loaders/x65.vkd: 2 phone(s), 6 boot(s)
...
```
