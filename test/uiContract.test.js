const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('left panel uses status bars for notices and fullscreen modals for choices', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');
  const projectsProvider = fs.readFileSync(path.join(root, 'src/views/projectsWebviewProvider.ts'), 'utf8');
  const combined = `${changesProvider}\n${projectsProvider}`;

  assert.match(combined, /notice-status-bar/);
  assert.match(combined, /choice-modal-backdrop/);
  assert.match(combined, /choice-modal/);
  assert.doesNotMatch(combined, /action-status-bar/);
});

test('ambiguous sync now command is not exposed in the VS Code UI', () => {
  const manifest = require('../package.json');
  const commands = manifest.contributes.commands.map(command => command.command);
  const titleCommands = manifest.contributes.menus['view/title'].map(item => item.command);

  assert.ok(!commands.includes('localleaf.syncNow'));
  assert.ok(!titleCommands.includes('localleaf.syncNow'));
  assert.ok(titleCommands.includes('localleaf.pullFromOverleaf'));
  assert.ok(titleCommands.includes('localleaf.pushToOverleaf'));
});

test('changes view activates the extension directly', () => {
  const manifest = require('../package.json');

  assert.ok(manifest.activationEvents.includes('onView:localleaf.changesView'));
});

test('clicking a change row opens a diff instead of the plain local file', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.ok(!changesProvider.includes("const openCmd = groupType === 'conflict' ? 'viewDiff' : 'openFile'"));
  assert.match(changesProvider, /enableCommandUris:\s*true/);
  assert.match(changesProvider, /root\.addEventListener\('click'/);
  assert.match(changesProvider, /data-command':'viewDiff'/);
  assert.match(changesProvider, /data-path':item\.path/);
});

test('every change item exposes a visible diff action', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.match(changesProvider, /const actions = \[\s*h\('button', \{className:'action-btn diff-btn'/);
  assert.match(changesProvider, /\.change-item \.actions\{[\s\S]*display:\s*flex/);
});

test('left panel status region is sticky at the top', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');
  const projectsProvider = fs.readFileSync(path.join(root, 'src/views/projectsWebviewProvider.ts'), 'utf8');

  for (const source of [changesProvider, projectsProvider]) {
    assert.match(source, /top-status-region/);
    assert.match(source, /\.top-status-region\{[\s\S]*position:\s*sticky/);
  }
  assert.match(changesProvider, /root\.appendChild\(renderTopStatusRegion\(\)\)/);
  assert.match(changesProvider, /renderPrimaryStatusBar/);
  assert.match(projectsProvider, /id="top-status-region"/);
});

test('changes panel primary status bar is default and not dismissible', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');

  assert.match(changesProvider, /status-left/);
  assert.match(changesProvider, /state\.statusText/);
  assert.doesNotMatch(changesProvider, /className:'notice-dismiss'/);
  assert.doesNotMatch(changesProvider, /command:'dismissNotice'/);
});

test('panel notices do not auto-dismiss through timers', () => {
  const changesProvider = fs.readFileSync(path.join(root, 'src/views/changesWebviewProvider.ts'), 'utf8');
  const projectsProvider = fs.readFileSync(path.join(root, 'src/views/projectsWebviewProvider.ts'), 'utf8');
  const extension = fs.readFileSync(path.join(root, 'src/extension.ts'), 'utf8');

  assert.doesNotMatch(changesProvider, /this\.notifications\.dismissNotice\(id, revision\)/);
  assert.doesNotMatch(projectsProvider, /this\.notifications\.dismissNotice\(id, revision\)/);
  assert.doesNotMatch(extension, /setTimeout\(\(\) => dismissPanelNotice\(token\), autoDismissMs\)/);
});
