import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const config = JSON.parse(read('../src-tauri/tauri.conf.json'));
const template = read('../src-tauri/installer/installer.nsi');
const branding = read('../src-tauri/installer/branding.nsh');
const nsis = config.bundle.windows.nsis;

test('branded NSIS keeps the existing installation identity', () => {
  assert.equal(config.productName, 'seWer Tauri');
  assert.equal(config.identifier, 'com.sewer.tauri');
  assert.equal(nsis.installMode, 'currentUser');
  assert.equal(nsis.template, 'installer/installer.nsi');
  assert.equal(nsis.installerHooks, 'installer/branding.nsh');
  assert.ok(template.includes('Name "seWer"'));
  assert.ok(template.includes('!define PRODUCTNAME "{{product_name}}"'));
  assert.ok(template.includes('"DisplayName" "seWer"'));
});

test('installer uses a captionless window and localized layouts with record artwork', () => {
  assert.deepEqual(nsis.languages, ['English', 'Russian']);
  assert.equal(nsis.sidebarImage, undefined);
  assert.equal(nsis.headerImage, undefined);
  assert.match(template, /^Page custom SewerWelcome /m);
  assert.match(template, /^Page custom SewerFinish SewerFinishLeave$/m);
  assert.match(branding, /SetWindowLongW\(p \$HWNDPARENT, i -16, i r1\)/);
  assert.match(branding, /SEWER_PLACE \$HWNDPARENT \$mui\.Button\.Cancel 261 7/);
  assert.match(template, /MUI_PAGE_CUSTOMFUNCTION_SHOW SewerDirectoryShow\s+!insertmacro MUI_PAGE_DIRECTORY/);
  assert.match(branding, /SEWER_PLACE \$mui\.DirectoryPage \$mui\.DirectoryPage\.Directory /);
  assert.match(template, /MUI_PAGE_CUSTOMFUNCTION_SHOW SewerProgressShow\s+!insertmacro MUI_PAGE_INSTFILES/);
  assert.doesNotMatch(template, /MUI_PAGE_(WELCOME|FINISH)/);
  assert.match(branding, /NSD_SetStretchedImage/);
  assert.match(branding, /NSD_FreeImage/);
  const cover = readFileSync(new URL('../src-tauri/installer/record.bmp', import.meta.url));
  assert.equal(cover.toString('ascii', 0, 2), 'BM');
  for (const name of new Set(Array.from(branding.matchAll(/^  LangString (\w+)/gm), match => match[1]))) {
    for (const lang of ['ENGLISH', 'RUSSIAN']) {
      assert.ok(branding.includes('LangString ' + name + ' ${LANG_' + lang + '}'));
    }
  }
});

test('maintenance shows both choices on the branded page with explicit text colors', () => {
  const page = template.match(/^Function PageReinstall\r?\n([\s\S]*?)^FunctionEnd/m)[1];
  assert.match(page, /Call SewerCreatePage[\s\S]*SEWER_RADIO 91u \$R2[\s\S]*SEWER_RADIO 118u \$R3[\s\S]*Call SewerShowPage/);
  const radio = branding.split('!macro SEWER_RADIO ')[1].split('!macroend')[0];
  assert.match(radio, /SetCtlColors \${HANDLE} "\${SEWER_TEXT}" "\${SEWER_BG}"/);
  assert.match(radio, /PageReinstallUpdateSelection/);
});

test('custom pages preserve passive updates and NSIS installation actions', () => {
  for (const page of ['SewerWelcome', 'SewerFinish']) {
    assert.match(branding, new RegExp('Function ' + page + '\\r?\\n    Call SkipIfPassive'));
  }
  for (const operation of ['MUI_PAGE_DIRECTORY', 'MUI_PAGE_INSTFILES', 'Section WebView2',
    'Section Install', 'Section Uninstall', 'Function PageReinstall', 'Function PageLeaveReinstall',
    'Function RestorePreviousInstallLocation', 'Function CreateOrUpdateDesktopShortcut',
    'Function CreateOrUpdateStartMenuShortcut', '"/UPDATE"', '"/NS"', '"/P"',
    'WriteUninstaller', 'DeleteAppDataCheckboxState', 'RunAsUser']) {
    assert.ok(template.includes(operation), operation);
  }
  const finishLeave = branding.split('Function SewerFinishLeave')[1].split('FunctionEnd')[0];
  assert.match(finishLeave, /RebootFlag[\s\S]*SewerRestartCheckbox[\s\S]*Reboot[\s\S]*Return/);
  assert.match(finishLeave, /SewerShortcutCheckbox[\s\S]*Call CreateOrUpdateDesktopShortcut/);
  assert.match(finishLeave, /SewerRunCheckbox[\s\S]*Call RunMainBinary/);
});
