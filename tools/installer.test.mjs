import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const config = JSON.parse(read('../src-tauri/tauri.conf.json'));
const template = read('../src-tauri/installer/installer.nsi');
const branding = read('../src-tauri/installer/branding.nsh');

test('branded NSIS is configured without changing the existing installation identity', () => {
  const nsis = config.bundle.windows.nsis;
  assert.equal(config.productName, 'seWer Tauri');
  assert.equal(config.identifier, 'com.sewer.tauri');
  assert.equal(nsis.installMode, 'currentUser');
  assert.equal(nsis.template, 'installer/installer.nsi');
  assert.equal(nsis.installerHooks, 'installer/branding.nsh');
  assert.ok(template.includes('Name "seWer"'));
  assert.ok(template.includes('!define PRODUCTNAME "{{product_name}}"'));
  assert.ok(template.includes('"DisplayName" "seWer"'));
});

test('the checked Yandex joke has no caption, handler, saved state or installation action', () => {
  assert.match(branding, /NSD_CreateCheckbox\}[^\n]+"установить яндекс"/);
  assert.match(branding, /\$\{NSD_Check\} \$SewerMemeCheckbox/);
  assert.equal(branding.includes('это мем'), false);
  assert.equal(branding.includes('ничего не устанавливает'), false);
  assert.equal(branding.includes('NSD_GetState} $SewerMemeCheckbox'), false);
  assert.equal(branding.includes('NSD_OnClick} $SewerMemeCheckbox'), false);
  assert.equal(branding.includes('NSD_OnChange} $SewerMemeCheckbox'), false);
  assert.equal(template.includes('$SewerMemeCheckbox'), false);
  for (const line of branding.split('\n').filter(line => line.includes('$SewerMemeCheckbox'))) {
    assert.match(line.trim(), /^(Pop|\$\{NSD_Check\}|SetCtlColors|SendMessage .*WM_SETFONT|System::Call .*SetWindowTheme)/);
  }
  assert.equal(/(?:Exec|WriteReg|download|File )[^\n]*(?:яндекс|yandex)/i.test(template + branding), false);
});

test('all pages are skinned but real update, runtime and uninstall operations remain', () => {
  for (const callback of ['SewerWelcomeShow', 'SewerFinishShow', 'SewerSkinPage', 'un.SewerSkinPage']) {
    assert.ok(template.includes(`MUI_PAGE_CUSTOMFUNCTION_SHOW ${callback}`));
  }
  for (const operation of ['Section WebView2', 'Section Install', 'Section Uninstall',
    'Function PageReinstall', 'Function PageLeaveReinstall', 'Function RestorePreviousInstallLocation',
    'Function CreateOrUpdateDesktopShortcut', 'Function CreateOrUpdateStartMenuShortcut',
    '"/UPDATE"', '"/NS"', '"/P"', 'WriteUninstaller', 'DeleteAppDataCheckboxState',
    'Call RunMainBinary', 'RunAsUser']) {
    // RunMainBinary is invoked by MUI's finish callback, not a manual Exec.
    if (operation === 'Call RunMainBinary') assert.ok(template.includes('MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary'));
    else assert.ok(template.includes(operation), operation);
  }
  assert.ok(template.includes('!insertmacro SEWER_INSTALLER_FUNCTIONS'));
  assert.match(branding, /\$\{If\} \$\{RebootFlag\}\r?\n      Return/);
});

test('installer artwork is local, high-DPI, valid 24-bit BMP with a matching dark background', () => {
  for (const [name, width, height] of [['sidebar', 328, 628], ['header', 300, 114]]) {
    const bitmap = readFileSync(new URL(`../src-tauri/installer/${name}.bmp`, import.meta.url));
    assert.equal(bitmap.toString('ascii', 0, 2), 'BM');
    assert.equal(bitmap.readUInt32LE(2), bitmap.length);
    assert.equal(bitmap.readInt32LE(18), width);
    assert.equal(bitmap.readInt32LE(22), height);
    assert.equal(bitmap.readUInt16LE(28), 24);
    const pixelOffset = bitmap.readUInt32LE(10);
    assert.deepEqual([...bitmap.subarray(pixelOffset, pixelOffset + 3)], [19, 13, 13]);
  }
  assert.ok(branding.includes('SEWER_BG "0D0D13"'));
});
