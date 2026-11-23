# seWer installer

The NSIS template is based on Tauri CLI 2.12.0 (MIT/Apache-2.0).
`branding.nsh` defines the captionless window, navigation, and page layouts
with native controls in English and Russian. The installation folder field
and progress log still use NSIS validation and status reporting. The package
uses Windows' language selection and falls back to English.

Keep the existing installation and removal sections when updating the
template. The registry identity remains `seWer Tauri` so the installer
can find existing copies.

Run `npm run app:build` to package the installer.
