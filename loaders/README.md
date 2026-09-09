# vklay-loaders

The built-in V_KLay phone driver (`.vkd`) files, taken from the original
V_KLay distribution (`data/Loaders/` of
<https://github.com/siemens-mobile-hacks/v-klay>). Each driver file describes
the boot sequence and the loader protocol of one phone family; the semantics
are implemented by the parser in [@sie-js/flasher](../core).

`manifest.json` lists all shipped drivers (file, display name, release date,
copyright). All files are plain data — the package has no code.

```js
import manifest from "vklay-loaders/manifest.json";
// fetch("vklay-loaders/x65.vkd") / fs.readFileSync("node_modules/vklay-loaders/x65.vkd")
```
