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
