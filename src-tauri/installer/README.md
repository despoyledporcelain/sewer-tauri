# seWer installer

`installer.nsi` is the NSIS template from Tauri CLI **2.12.0** (MIT/Apache-2.0),
with page-show callbacks and `branding.nsh` added. Upstream source:
https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.0/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

Keep the original installation and removal sections when updating the template.
In particular, the product/registry identity stays `seWer Tauri` so existing
installations are detected and updated rather than duplicated. Visible branding
is `seWer`.

The Yandex checkbox is deliberately cosmetic and checked initially.
It has no callbacks or installation actions.

Regenerate the bundled artwork on Windows with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/installer-assets.ps1
```

Build the actual installer with `npm run app:build`. No installer or application
is launched by the build or the automated tests.
