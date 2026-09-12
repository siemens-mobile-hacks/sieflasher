# sieflasher

The Siemens mobile phone flasher. Early work in progress.
Heavily based on [V_KLay](https://github.com/siemens-mobile-hacks/v-klay).

| Package                      | Description                                                                                                                                                                                              |
|------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| [`@sie-js/flasher`](core)    | The flasher core library: .vkd driver parsing, the phone boot sequence and the loader protocol, fullflash dumps, VKP patches. Works in the browser (WebSerial) and in Node.js. Can be used independently |
| [`vklay-loaders`](loaders)   | The built-in V_KLay phone driver (`.vkd`) files.                                                                                                                                                         |
| [`@sie-js/flasher-cli`](cli) | The `sieflasher` command line tool (work in progress).                                                                                                                                                  |
| [`tests`](tests)             | e2e tests: the CLI against the [pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu) phone emulator.                                                                                        |

The browser UI is the [Flasher page](https://tools.siepatch.dev/flasher) of
[web-tools](https://github.com/siemens-mobile-hacks/web-tools), which consumes
`@sie-js/flasher` and `vklay-loaders`.

## Development

Clone with submodules (the e2e fullflash dumps live in the
[fullflashes](https://git.siepatch.dev/siepatch/fullflashes) submodule):

```
git clone --recurse-submodules <url>
pnpm install
pnpm build
pnpm test
pnpm test:e2e         # needs git + the emulator build dependencies, see tests/README.md
pnpm test:e2e:smoke   # the quick matrix: every sub-minute test (42 of the 46)
```

See [core/README.md](core/README.md) for the flasher internals: the boot
sequence, the loader protocol, VKP patches, the .vkd driver files.
