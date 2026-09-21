# @sie-js/flasher

A faithful reimplementation of the [V_KLay](https://github.com/siemens-mobile-hacks/v-klay)
flasher for the old Siemens phones, both for the browser (WebSerial) and for
Node.js. Every feature that V_KLay implements for working with the phone and
with `.bin` fullflash dumps is reimplemented here; the original C++ sources of
V_KLay were ported function by function, and the source file / function is
referenced in a comment above each ported block.

The upstream V_KLay sources are **not** part of this repository — clone
<https://github.com/siemens-mobile-hacks/v-klay> to study the original
implementation side by side with the ports here. The original `.vkd` driver
files ship in the separate [`vklay-loaders`](../loaders) package.

The browser UI for the library is the
[Flasher page](https://tools.siepatch.dev/flasher) of
[web-tools](https://github.com/siemens-mobile-hacks/web-tools) (phone mode,
fullflash file mode, the VKP patch editor, the dump compare tool and the patch
history). The terminal UI is the
[`sieflasher` CLI](../cli) (work in progress).

## Installation

```
pnpm add @sie-js/flasher
```

* `@sie-js/flasher` — the platform-independent core library.
* `@sie-js/flasher/web` — the WebSerial transport (via `AsyncSerialPort`
  from `@sie-js/serial`), for browser use.

The built-in `.vkd` phone drivers from the original V_KLay distribution (with
their `manifest.json`) live in the sibling
[`vklay-loaders`](../loaders) package.

## Structure

```
src/                Platform independent library (works in browser and Node.js)
	ini.ts          Minimal INI parser (for the .vkd phone driver files)
	data.ts         Parsing of the vkd data values (0sAT escape strings, hex, 0b, 0x)
	vkd.ts          .vkd phone driver file model and parser
	memcache.ts     Paged flash memory cache (VDevCache port)
	device.ts       DeviceMemory / FlasherDevice contracts, V_KLay dump file naming
	fullflash.ts    Fullflash dump (.bin) as a device (VDeviceFile port)
	phone.ts        The phone flasher itself: boot sequence, loader protocol,
	                memory read/write, bootcore restore (VDevicePhone port)
	transport.ts    FlasherTransport interface (serial port abstraction)
	vkp.ts          VKP patch applying/undoing over any device
	diff.ts         Dump comparison helpers (diff regions, erase/fill statistics)
	index.ts
	web/
		transport.ts WebSerial implementation of the transport (via AsyncSerialPort)
```

In the browser the core library is wired to WebSerial through
`src/web/transport.ts`; the web-tools app connects it to its serial worker
stack (the `FLSH` protocol service around `PhoneDevice`). The sibling packages
of this monorepo: [`vklay-loaders`](../loaders) (the built-in `.vkd` drivers),
[`@sie-js/flasher-cli`](../cli) (the CLI), [`tests`](../tests) (the e2e tests
against the pmb887x-emu phone emulator).

## The .vkd phone driver files

V_KLay supports every phone generation through driver files that describe both
the boot sequence and the loader protocol variations (the originals live in
`data/Loaders/` of the V_KLay repository; the same files ship in the
[`vklay-loaders`](../loaders) package). The parser (`src/vkd.ts`) implements
the exact semantics of `VDevicePhone::LoadPhoneInfo()` /
`VPhoneLoaderOptions::Load()` / `VPhoneBoot::ReadInfo()`:

* **Section merging is sequential**: `[PhoneCommonInfo]` is loaded first, then
  every `[PhoneNN]` section is merged into that state — a phone section without
  its own `MCUMemFuBu` / `Boots` / `opt*` keys inherits the values of the
  *previous* section, exactly like V_KLay accumulates the state while iterating
  the sections.
* **`opt*` keys are all-or-nothing**: when a section contains any `opt*` key,
  the whole loader options set is reset to defaults and re-read; when it
  contains none, the previous options are kept.
* **`MCUMemGeometry`** (`0x400000: 0x020000, ...`) describes the flash IC
  erase-block layout; `MCUMemFuBu` / `MCUMemAreaNN` describe the memory map
  (`name, addr, size[, bootcore|nowrite|noread]`); `MCUMemFlashBase` overrides
  the loader's flash base for the v1 write addressing.
* **Boot sections** (`[BootNN]`) carry the raw bootcode payloads. The data
  values support all V_KLay forms: plain hex, comma-separated groups, `0x`/`0b`
  numbers, `0s...` escape strings (C-style escapes incl. `\xNN`, octal and
  `\uNNNN` with cp1251 encoding) and quoted strings — ported from
  `getdata()`/`ParseEscapeString()` in `V_Utilites.cpp`. Boot payloads can also
  be split across `Data01..DataNN` keys (used by the x65 password boot).
* Parameter lists use the `VGetParameterFromList()` tokenizer, which splits on
  both `,` and `:` and honours quoted entries.

All 20 drivers from the V_KLay distribution are parsed by the test suite.

## The boot sequence

`PhoneDevice.sendBoots()` / `sendBootWithIgnition()` port
`VPhoneBoot::LoadToPhone()`:

1. **Phase 1 — ignition**: DTR is raised to power the phone from the cable
   (DCA-510 style) while the connection boot (e.g. `AT` → `0xB0`) is sent in a
   loop for up to 500 ms.
2. **Phase 2 — power cycle**: the phone is power-cycled (DTR on, ignition edge
   wait, DTR off) to reach the bootcode entry condition.
3. **Phase 3 — power button**: the remaining boots are re-sent in a loop until
   the expected answer arrives, with a status message asking the user to press
   the power button shortly. `TryCount` limits the attempts (`-1` = infinite).

Each boot payload is sent as `[size (SizeLen bytes, little-endian)][data][xor
checksum]` unless `NoSendLen`/`NoSendCheckSum` is set (the `Connect`/`GoBoot`
boots use raw payloads). `PortSpeed` re-configures the port before a boot,
`DelayBefore`/`DelayAfter` add pauses. The whole boot sequence can be retried
(`optLoaderUploadTryCount` / `optLoaderUploadDelay`, V_KLay's
`LoaderUploadTryCount` semantics: `0` = fail immediately, `-1` = retry forever),
and the `skipLoaderLoadUnload` option reuses a loader that is already running in
the phone RAM (V_KLay's Shift+Ctrl+Alt). `autoIgnition: false` disables phases
1–2 (`o_AutoignitionType == AUTOIGN_NONE`).

## The loader protocol

After the boots, the loader in the phone answers single-character commands
(`src/phone.ts`, ported from `VDevicePhone.cpp`):

| Command | Meaning | V_KLay reference |
|---|---|---|
| `A` | ping, answered with `R` | `LoaderIsReady()` |
| `H`+code, `A` | switch baudrate (`h`/`H` handshake) | `LoaderSetConnectionSpeed()` |
| `I` | flash info (3 answer layouts, below) | `LoaderReadFlashInfo()` |
| `R`+addr+size | read flash | `LoaderReadMemory()` |
| `F`+addr(+size) | write/erase flash (2 protocol versions) | `LoaderWriteMemory()` |
| `.` | keepalive | `KeepAlive()` |
| `U`+5 bytes | x65 IMEI-based authorization | `LoaderAuthorization()` |
| `Q`, `Z` | stop the loader | `LoaderStopLoader()` |

The address/size fields are `optCmdAddrAndSizeLen` bytes wide, big-endian, and
carry the device address the flash is mapped at (0xA0000000 on x65), not the
flash offset the library is addressed by. Everything that varies between the
driver generations is controlled by the `opt*` keys: skip bytes after each
answer field, checksum type and order, OK-answer presence, write command
version, keepalive interval, baud code table, and so on.

### Flash info (`I`)

Three answer layouts are decoded by length, ported from
`VDevicePhone::MakeFlashInfoString()`:

* **560 bytes (v1)** — old loaders: strings, phone IDs and flash IC types at
  fixed offsets.
* **224 bytes (v2)** — the same fields without the leading 336-byte prefix.
* **128 bytes (v3)** — x65-family chaos loaders: model, manufacturer, ASCII
  IMEI, flash base, CFI flash VID/PID/size and the *erase block region table*.
  When the driver file has no `MCUMemGeometry`, the region table is used to
  build the page cache geometry (V_KLay does the same in
  `MakeFlashInfoString()`).

### Reading (`R`)

`LoaderReadMemory()` reads in chunks (starting at 64 KB, halving after repeated
errors, remembering the last good size ≥ 16 KB). The whole answer —
`[skip][data][skip][OK][checksum][skip]`, laid out per the driver's `opt*`
keys — is received in **one atomic transport read with inter-byte timeouts**
(the port of V_KLay's `canusetmpbuf` path), then sliced and verified: the `OK`
answer, the XOR checksum (little-endian word, `GetCheckSum()` port) and the
trailing skip bytes. On an error the chunk is re-read after the loader
readiness check, exactly like V_KLay, and the corrected-error counter grows.

> The inter-byte (idle) timeout semantics of `VDevicePhone::CommRead()` are
> essential: the first byte is waited for up to 1000 ms, and every following
> chunk *resets* that timeout. A plain total timeout would abort a steady
> 64 KB stream mid-flight and let the retry race against the still-streaming
> tail of the abandoned answer — misaligned but internally CRC-consistent data.
> The web transport (`src/web/transport.ts`) therefore implements exactly the
> V_KLay timeout model.

### Writing (`F`)

`LoaderWriteMemory()` implements both write protocol versions:

* **v1** (Freia-style, x25–x55): `F` + 16-bit block address (4 KB units,
  relative to `MCUMemFlashBase`). The phone answers with a 10-byte block
  descriptor and the block size, the data + XOR checksum is sent, then the
  data/erase/write acknowledgements (`0xBBBB` CRC NAK, `0x0202` erase OK,
  `0x0303` write OK), the written word checksum (sum of 16-bit words,
  `wordChecksum()`) and the final `OK` are verified. A special `F` + address 0
  command restores the bootcore (`optRestoreBootcoreCmdEnable`).
* **v2** (x65 chaos loaders): `F` + 32-bit absolute address + 32-bit size, with
  `0x0101` ACK, `0xEEEE` access denied, `0xFFFF` bounds, `0xCCCC` unknown flash
  NAKs.

Writes go through the **page cache** (`src/memcache.ts`, the `VDevCache`
port): the device is written page-wise, partial pages are read back first
(read-modify-write), unchanged pages are skipped, and `flush()` writes the
changed pages. Pages that overlap `bootcore`/`nowrite` areas are skipped
(configurable safety options; V_KLay asks per-write instead). The cache is
dropped before every top-level operation so repeated reads always fetch fresh
data from the phone.

### Authorization

x65 loaders (`optAuthorization=1`) require the port of V_KLay's IMEI LFSR: the
15-digit IMEI (packed BCD exactly like `VStrAToBCD()`) seeds a 32-bit LFSR
(0x23C steps, polynomial 0x93000) whose result is sent after `U`; the loader
confirms readiness with `R`.

## VKP patches

Patch *parsing* is delegated to
[@sie-js/vkp](https://github.com/siemens-mobile-hacks/node-sie-vkp); applying,
undoing and dry-running is `src/vkp.ts`, following
`CPatchPage::DoPatchApply()`/`DoPatchUndo()` (two phases, like
`PatchDataConvert()` + `PatchDataWrite()`: everything is read back and
classified first, the writes happen only after the user confirmed the
warnings):

* every write is compared against the device: new data already present →
  *already applied*; old data matches → write the new data; no old data →
  write (undo impossible, warned); mismatch → error with a hex preview at the
  first differing byte (or *forced apply*).
* **Addresses** follow the V_KLay convention: patch addresses are **offsets
  from the flash start** ("address 0xA15C0000 is 0x015C0000 in V_KLay"),
  which is the form x65/x75 patches use (`0xA165E8` → flash offset, not the
  absolute `0xA0A165E8`), and they are used as they are — every one of the
  2,007,746 writes of the 10,317-patch corpus in `tests/patches` is an offset.
  `PhoneDevice` adds the address the flash is mapped at (0xA0000000 on x65)
  once, at its own boundary; nothing above it deals in device addresses. A
  write outside `getMemoryStart() .. getMemoryStart() + getMemorySize()` is
  reported as an error, never relocated to make it fit.
* The **`+XXXX` offset corrector** of the VKP format is applied by the parser
  (`vkpParse`), so the addresses reaching this library are already corrected.
  It sets the correction rather than accumulating it, and `+0` cancels it.
* **Undo** reverses the logic (old data must be present, patched data is
  replaced by the old data).
* **Dry run** only reports. The result contains per-write reports and byte
  counts for the performance report.

### Repair patch ("restore patch")

When the device data does not match the old data of the patch (or the patch
has no old data at all), V_KLay asks before writing — and when the user
confirms, it first saves a **repair patch** that can undo the operation to the
*original* device data. This is ported as well (`confirmNoOld` /
`confirmMismatch` / `saveRepairPatch` options of `applyVkpToDevice`, the
analogs of the V_KLay message boxes):

* "no old data in the patch" is asked **before** anything is read (the
  `msgNoOldInPatch` box; suppressed per write by `#pragma disable undo` /
  `#pragma disable warn_no_old_on_apply`),
* "the old data of N from M blocks is not found in flash" is asked **once
  after the whole patch was converted** (`PatchDataTest_ShowNoOldWarning`,
  suppressed when everything is already applied), and one YES forces all the
  mismatches (V_KLay's `writenewanyway`),
* declining any box cancels the operation before a single byte is written
  (`cancelled` in the result),
* cancelling the repair patch save aborts too (V_KLay's
  `o_bIsRepairPatchCanSkip=FALSE`).

The repair patch itself (`makeRepairPatchText()`, the port of
`RepairPatchSave()` + `VPatchBlock::MakeTextLine()`) is a regular VKP file
where *old data = the original data read from the device* and *new data =
what this operation writes* — undoing it restores the original device data
even when the applied patch has no (or wrong) old data. The format matches
V_KLay: the `*** REPAIR PATCH ***` header with the patch name/description
embedded, `#pragma disable warn_if_old_exist_on_undo`, and 16-byte aligned
hex columns (`addr: old new ;expected`) split into the "different" and
"same" device-vs-old-data sections. The suggested file name is
`{patch}_REPAIR.vkp` (`RepairPatchGetFileName()`).

Every successfully applied or undone patch should be logged by the caller
(the web analog of V_KLay's patch logging, `CPatchPage::DoPatchLogging` —
V_KLay saves the applied patch into its `log\` directory and calls
`log.exe`/`log.bat`); dry runs, no-ops ("already applied") and failed runs
are not logged — exactly like `DoPatchLogging()` is only called after a
successful `PatchDataWrite()` in V_KLay.

## Dump files

The V_KLay naming scheme is used for saved dumps (`GetDefaultFlashFileName()`
port, `src/device.ts`):

```
{DeviceName}_{YYYY-MM-DD_HH-MM-SS}_From_{XX}.bin     XX = start address in 64k units
```

Opening a dump extracts the start address from the file name with the exact
`GetAddrFromFileName()` rules: the trailing `_-HHHH`, `_HHHH`, `_+-HH` or `_HH`
group before the extension, multiplied by 0x10000. The phone model is
auto-detected from the file name prefix (`S55_...` selects the S55 phone of
the matching driver), like `CFlasherPage::OpenDocument()`.

## Using the core library in a Node.js CLI tool

The core has no web dependencies (Buffer is polyfilled by the bundler in
browser apps and native in Node). A CLI tool only needs to implement the
`FlasherTransport` interface on top of e.g. `serialport` — see the
[`sieflasher` CLI](../cli) (`vkd-dump` is implemented; the phone commands
and a TCP transport for the pmb887x-emu emulator are planned, exercised by the
[e2e tests](../tests)):

```ts
import { parseVkd, PhoneDevice, applyVkpToDevice, FullFlashDevice, diffBuffers } from "@sie-js/flasher";
import { vkpNormalize, vkpParse } from "@sie-js/vkp";
import { SerialPort } from "serialport";

class NodeSerialTransport /* implements FlasherTransport */ { /* ... */ }

// Boot the phone and read the fullflash (the built-in drivers are in the
// vklay-loaders package)
const vkd = parseVkd(fs.readFileSync("x65.vkd", "latin1"));
const phone = vkd.phones[0];
const device = new PhoneDevice(transport, phone, vkd.boots, { skipBootcore: true });
await device.open(115200);
// Addresses are offsets from the flash start, like in the patches and in
// the V_KLay fields: the whole flash is 0 .. device.getMemorySize().
const fullflash = await device.readFlash(0, device.getMemorySize());
await device.disconnect();

// Apply a VKP patch to a dump file (the second argument is the flash offset
// the dump starts at, for a dump of a part of the flash)
const dump = new FullFlashDevice(fs.readFileSync("fullflash.bin"));
const vkp = vkpParse(vkpNormalize(fs.readFileSync("patch.vkp")));
const result = await applyVkpToDevice(dump, vkp, { dryRun: true });

// Compare two dumps (debugging read differences)
for (const region of diffBuffers(dumpA, dumpB))
	console.log(`0x${region.addr.toString(16)} +${region.length}`);
```

For the browser, `@sie-js/flasher/web` provides `AsyncSerialPortTransport`,
the WebSerial implementation of the transport.

## Testing

`tests/flasher.test.ts` runs against mock phone emulators (both loader
protocol generations) and against `.vkd` driver definitions:

* vkd data value / INI / driver parsing (sequential section inheritance,
  geometry, option inheritance)
* v1 protocol end-to-end: ignition boot, baudrate switch, flash info v2,
  adaptive-size reads with retries, page-granularity writes,
  bootcore write skipping
* v2 (x65) protocol end-to-end: password boot, IMEI authorization, flash info
  v3 with geometry extraction, absolute-address writes
* boot sequence retry, skip-loader mode, disabled autoignition
* operation-wide progress, fresh re-reads (cache invalidation)
* fullflash file device bounds, VKP apply/undo/force/dry-run,
  repair patch generation/round-trip (undoing the repair patch restores the
  original data), declined confirmations, V_KLay line format,
  dump comparison helpers

Run with `pnpm test` (Node's built-in test runner; the runner compiles the
needed TypeScript first).

## References

* V_KLay sources: <https://github.com/siemens-mobile-hacks/v-klay> —
  `VDevicePhone.cpp` is the main reference for the phone protocol,
  `VDevice.cpp`/`VDeviceFile.cpp` for the device model, `PatchPage.cpp` for
  the patch semantics, `V_Klay.cpp`/`V_Utilites.cpp` for the helpers.
* VKP parser: <https://github.com/siemens-mobile-hacks/node-sie-vkp>
* Another V_KLay reimplementation used as a reference for the x65 chaos
  loader: <https://github.com/siemens-mobile-hacks/siepatcher>
