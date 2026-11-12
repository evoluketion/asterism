'use strict';
// Automated end-to-end check, only loaded when ASTERISM_TEST is set.
//   ASTERISM_TEST=demo  fake claude panes driven through every state, screenshots, MCP round trip
//   ASTERISM_TEST=real  one real `claude` pane: send a tiny prompt, wait for the Stop hook
// Writes results to $ASTERISM_TEST_OUT/result.json and screenshots alongside, then quits.

const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run({ app, win, manager, store }) {
  const out = process.env.ASTERISM_TEST_OUT || path.join(app.getPath('userData'), 'selftest');
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[check] ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' — ' + JSON.stringify(detail)}`); };
  const js = code => win.webContents.executeJavaScript(code);
  const shot = async file => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, file), img.toPNG());
  };
  const waitFor = async (fn, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(150); }
    return false;
  };
  const stateOf = id => manager.get(id) && manager.get(id).status.state;
  const type = (id, s) => manager.panes.get(id).proc.write(s); // bypasses input acknowledgement

  await new Promise(r => win.webContents.once('did-finish-load', r));
  await waitFor(() => js('!!window.__asterismTest'));
  if (process.env.ASTERISM_SIZE) {
    const [w, h] = process.env.ASTERISM_SIZE.split('x').map(Number);
    win.setContentSize(w, h);
  }

  try {
    if (process.env.ASTERISM_TEST === 'real') await realTest();
    else if (process.env.ASTERISM_TEST === 'shots') await shotsMode();
    else await demoTest();
  } catch (err) {
    check('no exception', false, String(err && err.stack || err));
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log(`SELFTEST ${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail && !r.ok ? ' — ' + JSON.stringify(r.detail) : ''}`);
  app.exit(failed.length ? 1 : 0);

  async function demoTest() {
    const fake = path.join(__dirname, '..', '..', 'test', 'fake-claude.js');
    const node = process.env.ASTERISM_NODE || 'node';
    store.setSettings({ claudeCommand: `${node} ${fake}`, notifyDesktop: false, sound: false });
    process.env.ASTERISM_MCP_OUT = path.join(out, 'mcp-out.json');
    const root = path.join(__dirname, '..', '..');
    // Claude only writes a transcript once a conversation has a message; resume checks for it.
    const claudeCfg = fs.mkdtempSync(path.join(app.getPath('temp'), 'asterism-claude-'));
    fs.mkdirSync(path.join(claudeCfg, 'projects', 'fake'), { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeCfg;
    const saveTranscript = sid => sid && fs.writeFileSync(path.join(claudeCfg, 'projects', 'fake', `${sid}.jsonl`), '{}\n');
    const names = ['api-server', 'web-client', 'infra', 'docs'];
    const ids = [];
    // Regression: the first pane opened from the empty screen must sit below the toolbar.
    const probe = () => js(`(() => { const g = document.querySelector('#grid').getBoundingClientRect(); const p = document.querySelector('.pane'); return { grid: g.top, pane: p ? p.getBoundingClientRect().top : null, tb: document.querySelector('#toolbar').getBoundingClientRect().bottom, sc: [...document.querySelectorAll('*')].filter(e => e.scrollTop && !e.closest('.xterm-viewport, .xterm-scrollable-element')).map(e => e.id || e.className + ':' + e.scrollTop) }; })()`);
    for (let i = 0; i < 4; i++) {
      if (i === 0) {
        // Open the first pane the way a user does: the empty screen's button, then Enter in the picker.
        await js(`document.querySelector('#empty-new').click()`);
        await sleep(300);
        await js(`(() => { const d = document.querySelector('#np-dir'); d.value = ${JSON.stringify(root)}; document.querySelector('#np-name').value = ${JSON.stringify(names[0])}; d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
        await sleep(300);
        ids.push(await js(`window.__asterismTest.state().order[0]`));
      } else ids.push(await js(`window.__asterismTest.newPane(${JSON.stringify({ kind: i === 3 ? 'shell' : 'claude', name: names[i], cwd: root })})`));
      if (i === 0) {
        await sleep(600);
        const pr = await probe();
        await shot('00-first-pane.png');
        check('first pane sits below the toolbar', pr.pane >= pr.tb && pr.sc.length === 0, pr);
        // Force the bad state (the pane frame scrolled under the toolbar) and check it snaps back.
        await js(`(() => { document.querySelector('.pane').scrollTop = 40; document.documentElement.scrollTop = 40; })()`);
        await sleep(200);
        const pr2 = await probe();
        check('a stray scroll of the pane frame snaps back', pr2.pane >= pr2.tb && pr2.sc.length === 0, pr2);
      }
    }
    check('4 panes created', ids.length === 4 && ids.every(Boolean), ids);

    // Regression: opening the new-pane popover repeatedly must not stack Enter handlers.
    const before = (await js('window.__asterismTest.state()')).order.length;
    const pressEnter = `document.querySelector('#popover #np-dir').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`;
    for (let i = 0; i < 3; i++) { await js(`window.__asterismTest.newPanePopover('shell')`); await js(`document.querySelector('#popover #np-cancel').click()`); }
    await js(`window.__asterismTest.newPanePopover('shell')`);
    await js(pressEnter);
    await js(pressEnter);
    await sleep(800);
    const afterIds = (await js('window.__asterismTest.state()')).order;
    check('popover opened 4x + Enter twice opens exactly 1 pane', afterIds.length === before + 1, { before, after: afterIds.length });
    await js(`window.__asterismTest.closePane(${JSON.stringify(afterIds[afterIds.length - 1])}, { force: true })`);
    await sleep(300);
    const st = await js('window.__asterismTest.state()');
    check('grid layout of 4', st.preset === 'grid' && st.order.length === 4, st.order);
    check('terminals sized', st.panes.every(p => p.cols > 20 && p.rows > 5), st.panes.map(p => [p.cols, p.rows]));

    check('SessionStart (exec-form curl hook) → idle', await waitFor(() => [0, 1, 2].every(i => stateOf(ids[i]) === 'idle')), ids.map(stateOf));
    check('shell pane is shell', stateOf(ids[3]) === 'shell');

    type(ids[0], 'work\r');
    check('UserPromptSubmit → working', await waitFor(() => stateOf(ids[0]) === 'working'), stateOf(ids[0]));
    check('current tool recorded', manager.get(ids[0]).status.currentTool === 'Bash');

    type(ids[1], 'work Fix the flaky login test\r');
    await waitFor(() => stateOf(ids[1]) === 'working');
    type(ids[1], 'perm\r');
    check('PermissionRequest → permission', await waitFor(() => stateOf(ids[1]) === 'permission'), stateOf(ids[1]));

    type(ids[2], 'work Update the terraform module\r');
    await waitFor(() => stateOf(ids[2]) === 'working');
    type(ids[2], 'done\r');
    check('Stop → ready', await waitFor(() => stateOf(ids[2]) === 'ready'), stateOf(ids[2]));
    check('last reply from Stop payload', /42 tests/.test(manager.get(ids[2]).status.lastReply || ''));

    type(ids[3], 'echo "hello from the shell pane"; git --version\r');
    await sleep(800);
    await js(`window.__asterismTest.focusPane(${JSON.stringify(ids[0])})`);
    await sleep(500);
    await shot('01-grid-states.png');

    const order = await js('(() => { const t = window.__asterismTest; t.jumpToWaiting(); return t.state().focused; })()');
    check('jump goes to permission pane before ready pane', order === ids[1], order);
    const order2 = await js('(() => { const t = window.__asterismTest; t.jumpToWaiting(); return t.state().focused; })()');
    check('jump again cycles to ready pane', order2 === ids[2], order2);

    // Typing into a ready pane acknowledges it.
    manager.write(ids[2], ' ');
    check('keystroke acknowledges ready → idle', await waitFor(() => stateOf(ids[2]) === 'idle'), stateOf(ids[2]));
    manager.write(ids[2], '\x7f');

    type(ids[2], 'ask\r');
    check('AskUserQuestion → question', await waitFor(() => stateOf(ids[2]) === 'question'));
    type(ids[2], 'fail\r');
    check('StopFailure → error', await waitFor(() => stateOf(ids[2]) === 'error'));

    // MCP round trip from inside pane 1.
    type(ids[0], 'mcp\r');
    const mcpFile = path.join(out, 'mcp-out.json');
    const gotMcp = await waitFor(() => fs.existsSync(mcpFile));
    check('MCP round trip', gotMcp);
    if (gotMcp) {
      const m = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
      check('MCP protocol negotiated', m.protocol === '2025-11-25', m.protocol);
      check('MCP tools listed', ['list_panes', 'get_pane_transcript', 'read_pane_screen'].every(t => m.tools.includes(t)), m.tools);
      check('list_panes shows 4 panes, caller marked', m.panes.length === 4 && m.panes[0].you === true && m.panes[1].state === 'permission', m.panes);
      check('read_pane_screen returns text', /Fake Claude Code/.test(m.screen), m.screen.slice(0, 200));
    }

    // Interrupt fallback: Esc while working, then silence.
    type(ids[0], 'work\r');
    await waitFor(() => stateOf(ids[0]) === 'working');
    await sleep(300);
    manager.write(ids[0], '\x1b');
    check('Esc + quiet → idle (interrupted)', await waitFor(() => stateOf(ids[0]) === 'idle', 4000), [stateOf(ids[0]), manager.get(ids[0]).status.inferred]);

    // Layout presets.
    for (const p of ['columns', 'rows', 'main-left', 'main-top', 'grid']) {
      await js(`window.__asterismTest.setPreset('${p}')`);
      await sleep(250);
      const s = await js('window.__asterismTest.state()');
      check(`preset ${p} keeps panes sized`, s.panes.every(x => x.cols > 10 && x.rows > 3), s.panes.map(x => [x.cols, x.rows]));
      if (p === 'main-left') await shot('02-main-left.png');
    }
    type(ids[1], 'done Fixed: the login test was racing the session cookie.\r');
    await waitFor(() => stateOf(ids[1]) === 'ready');
    await js(`window.__asterismTest.toggleZoom(${JSON.stringify(ids[1])})`);
    await sleep(400);
    await shot('03-zoom.png');
    await js('window.__asterismTest.toggleZoom()');

    // Ctrl+Tab / Ctrl+Shift+Tab cycle panes in number order and wrap.
    {
      const tab = shift => js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', ctrlKey: true, shiftKey: ${shift}, bubbles: true }))`);
      const focused = () => js('window.__asterismTest.state().focused');
      const order = await js('window.__asterismTest.state().order');
      await js(`window.__asterismTest.focusPane(${JSON.stringify(order[order.length - 1])})`);
      await tab(false);
      const a = await focused();
      await tab(false);
      const b = await focused();
      await tab(true); await tab(true);
      const c = await focused();
      check('Ctrl+Tab goes to the next pane and wraps; Ctrl+Shift+Tab goes back', a === order[0] && b === order[1] && c === order[order.length - 1], { order, a, b, c });
    }

    // Ctrl+Shift+H hides the toolbar; panes grow; hovering the top edge slides it back down.
    const hk = code => js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}', ctrlKey: true, shiftKey: true, bubbles: true }))`);
    const gridTop = () => js(`document.querySelector('#grid').getBoundingClientRect().top`);
    const toolbarBottom = () => js(`document.querySelector('#toolbar').getBoundingClientRect().bottom`);
    const topBefore = await gridTop();
    await hk('KeyH');
    await sleep(500);
    check('Ctrl+Shift+H hides toolbar and panes take the space', (await gridTop()) < topBefore && (await toolbarBottom()) <= 1, { topBefore, top: await gridTop(), tb: await toolbarBottom() });
    check('hidden toolbar is remembered', store.settings.toolbarHidden === true);
    await shot('05-toolbar-hidden.png');
    await js(`document.querySelector('#toolbar-reveal').dispatchEvent(new MouseEvent('mouseenter'))`);
    await sleep(400);
    check('hovering the top edge slides the toolbar down', (await toolbarBottom()) > 30, await toolbarBottom());
    await shot('06-toolbar-peek.png');
    await js(`document.querySelector('#toolbar').dispatchEvent(new MouseEvent('mouseleave'))`);
    await sleep(700);
    check('…and it slides away again', (await toolbarBottom()) <= 1, await toolbarBottom());
    await hk('KeyH');
    await sleep(400);
    check('Ctrl+Shift+H brings the toolbar back', (await gridTop()) === topBefore && store.settings.toolbarHidden === false, await gridTop());

    // F11 toggles fullscreen (handled in the main process).
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
    const fs1 = await waitFor(() => win.isFullScreen(), 3000);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
    const fs2 = await waitFor(() => !win.isFullScreen(), 3000);
    check('F11 enters and leaves fullscreen', fs1 && fs2, { fs1, fs2 });
    await sleep(500);

    // Session serialization + SessionEnd.
    const ws = await js('window.__asterismTest.serializeLayout()');
    check('workspace serializes session ids', ws.panes.length === 4 && /^fake-/.test(ws.panes[0].sessionId || ''), ws.panes);
    type(ids[2], 'quit\r');
    check('SessionEnd → shell', await waitFor(() => stateOf(ids[2]) === 'shell'));
    const sid2 = manager.get(ids[2]).status.sessionId;
    saveTranscript(sid2);
    manager.relaunchClaude(ids[2]);
    check('↻ Claude relaunches in the same shell and resumes the session',
      await waitFor(() => stateOf(ids[2]) === 'idle' && manager.get(ids[2]).status.sessionId === sid2), [stateOf(ids[2]), manager.get(ids[2]).status.sessionId, sid2]);

    // Typing `claude` by hand in a shell pane (after a cd) goes through the shim and gets hooks.
    const tmp = app.getPath('temp');
    type(ids[3], `cd ${JSON.stringify(tmp)} && claude\r`);
    check('hand-typed claude in a shell pane is hooked', await waitFor(() => stateOf(ids[3]) === 'idle' && manager.get(ids[3]).status.kind === 'claude'), [stateOf(ids[3]), manager.get(ids[3]).status.kind]);
    check('…and records the folder it started in', manager.get(ids[3]).status.startCwd === tmp, manager.get(ids[3]).status.startCwd);
    type(ids[3], 'quit\r');
    await waitFor(() => stateOf(ids[3]) === 'shell');

    const keyN = () => js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyN', key: 'N', ctrlKey: true, shiftKey: true, bubbles: true }))`);
    const popOpen = (sel = '#np-dir') => js(`!document.querySelector('#popover').classList.contains('hidden') && !!document.querySelector('#popover ${sel}')`);

    // Outside a project, Ctrl+Shift+N asks for a folder (same picker as Ctrl+Shift+O).
    const n0 = (await js('window.__asterismTest.state()')).order.length;
    await keyN();
    await sleep(300);
    check('no project: Ctrl+Shift+N opens the folder picker, no pane yet', (await popOpen()) && (await js('window.__asterismTest.state()')).order.length === n0);
    await js(`document.querySelector('#popover #np-cancel').click()`);
    await sleep(200);

    // Create a project that keeps the open panes.
    await js(`window.__asterismTest.createProject({ name: 'asterism-test', dir: ${JSON.stringify(tmp)}, adopt: true })`);
    await sleep(600);
    const projA = Object.values(store.data.projects).find(p => p.name === 'asterism-test');
    check('new project keeps the open panes and saves them', projA && projA.dir === tmp && projA.layout && projA.layout.panes.length === n0, projA);
    check('…and is now the active project', (await js('window.__asterismTest.state()')).project === (projA && projA.id));
    check('toolbar shows the project', await js(`document.querySelector('#btn-project').textContent.includes('asterism-test')`));

    // In a project, Ctrl+Shift+N opens Claude in the project folder straight away.
    await keyN();
    await sleep(800);
    const sN = await js('window.__asterismTest.state()');
    const newId = sN.order[sN.order.length - 1];
    check('in a project: Ctrl+Shift+N opens one pane, no picker', sN.order.length === n0 + 1 && !(await popOpen()), { n0, n: sN.order.length });
    check('…a Claude pane in the project folder', manager.get(newId).kind === 'claude' && manager.get(newId).cwd === tmp, [manager.get(newId).kind, manager.get(newId).cwd]);
    check('…which reaches idle via hooks', await waitFor(() => stateOf(newId) === 'idle'), stateOf(newId));
    await sleep(500);
    check('…and the project saved it', store.data.projects[projA.id].layout.panes.length === n0 + 1, store.data.projects[projA.id].layout.panes.length);
    check('…with its name marked as the default', store.data.projects[projA.id].layout.panes[n0].name === null, store.data.projects[projA.id].layout.panes[n0]);
    // /exit, cd elsewhere, run claude by hand: still hooked, and the pane renames to the new folder.
    type(newId, 'quit\r');
    await waitFor(() => stateOf(newId) === 'shell');
    type(newId, `cd ${JSON.stringify(root)} && claude\r`);
    check('/exit + cd + claude: hooked and renamed after the new folder', await waitFor(() => stateOf(newId) === 'idle' && manager.get(newId).name === path.basename(root)), [stateOf(newId), manager.get(newId).name]);
    // Rename through the popover, then clear it: the pane goes back to its folder name.
    const renameTo = async value => {
      await hk('KeyR');
      await waitFor(() => popOpen('#rn'), 2000);
      await js(`(() => { const i = document.querySelector('#popover #rn'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    };
    await renameTo('picked');
    check('rename popover sets a chosen name', await waitFor(() => manager.get(newId).name === 'picked' && !manager.get(newId).autoName, 2000), manager.get(newId).name);
    await renameTo('');
    check('…and clearing it restores the folder name', await waitFor(() => manager.get(newId).name === path.basename(root) && manager.get(newId).autoName, 2000), manager.get(newId).name);
    await js(`document.querySelector('.pane[data-id=${JSON.stringify(newId)}] .pane-bar').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
    check('right-click on the title bar opens the rename popover', await waitFor(() => popOpen('#rn'), 2000));
    await js(`document.querySelector('#popover #rn-ok').click()`);
    await waitFor(async () => !(await popOpen('#rn')), 2000);
    check('…and confirming the unchanged name keeps it following the folder', manager.get(newId).autoName === true, manager.get(newId).name);
    type(newId, 'quit\r');
    await waitFor(() => stateOf(newId) === 'shell');
    await js(`window.__asterismTest.closePane(${JSON.stringify(newId)}, { force: true })`);
    await sleep(300);

    // Ctrl+Shift+O opens the folder-picker popover.
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyO', key: 'O', ctrlKey: true, shiftKey: true, bubbles: true }))`);
    await sleep(300);
    check('Ctrl+Shift+O opens the folder picker', await js(`!document.querySelector('#popover').classList.contains('hidden') && !!document.querySelector('#popover #np-dir')`));
    await js(`document.querySelector('#popover #np-cancel').click()`);
    await sleep(200);


    await js(`window.__asterismTest.closePane(${JSON.stringify(ids[3])}, { force: true })`);
    await sleep(300);
    const s3 = await js('window.__asterismTest.state()');
    check('close pane re-tiles', s3.order.length === 3, s3.order);
    await shot('04-three-panes.png');

    // Restore the 4-pane layout with resume: claude panes must get --resume <their session id>.
    // Pane 2 never had a message, so it has no transcript and must start a new session instead.
    saveTranscript(ws.panes[0].sessionId);
    for (const id of s3.order) await js(`window.__asterismTest.closePane(${JSON.stringify(id)}, { force: true })`);
    await js(`window.__asterismTest.openLayout(${JSON.stringify(ws)}, { resume: true })`);
    const s4 = await js('window.__asterismTest.state()');
    check('layout restore recreates 4 panes', s4.order.length === 4, s4.order);
    const resumed = await waitFor(() => s4.order.slice(0, 3).every(id => manager.get(id) && manager.get(id).status.sessionId), 10000);
    const got = s4.order.slice(0, 3).map(id => manager.get(id).status.sessionId);
    const want = ws.panes.slice(0, 3).map(p => p.sessionId);
    check('restore resumes each saved Claude session', resumed && got[0] === want[0] && got[2] === want[2], { got, want });
    check('…and a blank session with no transcript starts fresh', resumed && got[1] && got[1] !== want[1], { got, want });
    const restoredNames = s4.order.map(id => [manager.get(id).name, manager.get(id).autoName]);
    check('restore keeps each pane\'s chosen name', restoredNames.every(([n, auto], i) => n === ws.panes[i].name && auto === false), restoredNames);

    // Switching projects: the current one keeps its panes, the new one starts empty.
    await waitFor(() => s4.order.every(id => ['idle', 'shell'].includes(stateOf(id))));
    await sleep(500);
    const savedA = store.data.projects[projA.id].layout.panes.map(p => p.sessionId);
    savedA.forEach(saveTranscript);
    await js(`window.__asterismTest.createProject({ name: 'other', dir: ${JSON.stringify(root)}, adopt: false })`);
    await sleep(600);
    const projB = Object.values(store.data.projects).find(p => p.name === 'other');
    const sB = await js('window.__asterismTest.state()');
    check('creating a second project switches to it, empty', projB && sB.project === projB.id && sB.order.length === 0, sB);
    check('…and the first project kept its panes', store.data.projects[projA.id].layout.panes.length === 4, store.data.projects[projA.id].layout.panes.length);
    check('empty screen names the project', await js(`document.querySelector('#empty h1').textContent === 'other'`));
    await shot('07-project-empty.png');
    await js('window.__asterismTest.projectsPopover()');
    await sleep(300);
    await shot('08-projects-menu.png');
    await js(`document.querySelector('#btn-project').click()`);
    await sleep(200);
    await keyN();
    await sleep(800);
    const bId = (await js('window.__asterismTest.state()')).order[0];
    check('Ctrl+Shift+N in the second project uses its folder', bId && manager.get(bId).cwd === root, bId && manager.get(bId).cwd);
    await waitFor(() => stateOf(bId) === 'idle');
    await sleep(400);

    // Back to the first project: its panes return with their conversations resumed.
    await js(`window.__asterismTest.openProject(${JSON.stringify(projA.id)})`);
    await sleep(600);
    const sA = await js('window.__asterismTest.state()');
    check('switching back restores the first project\'s panes', sA.project === projA.id && sA.order.length === 4, sA.order);
    const resumedA = await waitFor(() => sA.order.slice(0, 3).every(id => manager.get(id) && manager.get(id).status.sessionId), 10000);
    const gotA = sA.order.slice(0, 3).map(id => manager.get(id).status.sessionId);
    check('…resuming their conversations', resumedA && gotA.every((sid, i) => sid === savedA[i]), { gotA, savedA });
    check('the second project kept its pane', store.data.projects[projB.id].layout.panes.length === 1, store.data.projects[projB.id].layout);
    await waitFor(() => sA.order.every(id => ['idle', 'shell'].includes(stateOf(id))));

    // Themes: clicking a card previews it on the chrome and every terminal; Cancel reverts; Save keeps it.
    {
      const bgVar = () => js(`getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()`);
      const before = await bgVar();
      await js('window.__asterismTest.settingsModal()');
      await sleep(200);
      const cards = await js(`document.querySelectorAll('#modal .theme-card').length`);
      check('settings lists the themes', cards >= 10, cards);
      await js(`document.querySelector('#modal .theme-card[data-theme="github-light"]').click()`);
      await sleep(300);
      check('clicking a theme previews it', (await bgVar()) === '#ffffff', await bgVar());
      await js(`document.querySelector('#set-cancel').click()`);
      await sleep(200);
      check('Cancel puts the saved theme back', (await bgVar()) === before, await bgVar());
      for (const id of ['catppuccin-latte', 'tokyo-night']) {
        await js('window.__asterismTest.settingsModal()');
        await sleep(150);
        await js(`document.querySelector('#modal .theme-card[data-theme="${id}"]').click()`);
        await sleep(200);
        await shot(`10-picker-${id}.png`);
        await js(`document.querySelector('#set-save').click()`);
        await sleep(500);
        await shot(`09-theme-${id}.png`);
      }
      check('Save keeps the theme', store.settings.theme === 'tokyo-night' && (await bgVar()) === '#1a1b26', [store.settings.theme, await bgVar()]);
      const tbg = (await js('window.__asterismTest.state()')).panes.map(p => p.termBg);
      check('terminals follow the theme', tbg.length && tbg.every(b => b === '#1a1b26'), tbg);
    }

    // Leaving the project closes its panes (kept in the project) and Ctrl+Shift+N asks again.
    await js('window.__asterismTest.leaveProject()');
    await sleep(400);
    const sL = await js('window.__asterismTest.state()');
    check('leave project: no panes, no project', sL.project === null && sL.order.length === 0, sL);
    check('…the project still has its panes', store.data.projects[projA.id].layout.panes.length === 4);
    check('…and the empty screen offers to reopen it', await js(`!document.querySelector('#empty-restore').classList.contains('hidden') && document.querySelector('#empty-restore').textContent.includes('asterism-test')`));
    await keyN();
    await sleep(300);
    check('…and Ctrl+Shift+N asks for a folder again', await popOpen());
    await js(`document.querySelector('#popover #np-cancel').click()`);
  }

  // README screenshots: four fake Claude panes in different states, inside a project. No shell
  // panes, so no user prompt (username, hostname) ends up in the images.
  async function shotsMode() {
    const fake = path.join(__dirname, '..', '..', 'test', 'fake-claude.js');
    store.setSettings({ claudeCommand: `${process.env.ASTERISM_NODE || 'node'} ${fake}`, notifyDesktop: false, sound: false, theme: 'asterism' });
    const base = path.join(app.getPath('temp'), 'asterism-shots');
    const names = ['api-server', 'web-client', 'infra', 'docs'];
    for (const n of names) fs.mkdirSync(path.join(base, n), { recursive: true });
    await js(`window.__asterismTest.applyTheme('asterism')`);
    await js(`window.__asterismTest.createProject({ name: 'acme', dir: ${JSON.stringify(base)}, adopt: false })`);
    await sleep(400);
    const ids = [];
    for (const n of names) ids.push(await js(`window.__asterismTest.newPane(${JSON.stringify({ kind: 'claude', name: n, cwd: path.join(base, n) })})`));
    check('four panes', await waitFor(() => ids.every(id => stateOf(id) === 'idle')), ids.map(stateOf));
    type(ids[0], 'work Refactor the auth middleware and add tests\r');
    type(ids[1], 'work Fix the flaky login test\r');
    await waitFor(() => stateOf(ids[1]) === 'working');
    type(ids[1], 'perm\r');
    type(ids[2], 'work Update the terraform module\r');
    await waitFor(() => stateOf(ids[2]) === 'working');
    type(ids[2], 'done\r');
    check('states set', await waitFor(() => stateOf(ids[0]) === 'working' && stateOf(ids[1]) === 'permission' && stateOf(ids[2]) === 'ready'), ids.map(stateOf));
    await js(`window.__asterismTest.focusPane(${JSON.stringify(ids[3])})`);
    await sleep(1500);
    await shot('screenshot.png');
    await js('window.__asterismTest.settingsModal()');
    await sleep(300);
    await js(`document.querySelector('#modal .theme-card[data-theme="tokyo-night"]').click()`);
    await sleep(500);
    await shot('themes.png');
    await js(`document.querySelector('#set-cancel').click()`);
  }

  async function realTest() {
    store.setSettings({ claudeCommand: 'claude', notifyDesktop: false, sound: false });
    const cwd = process.env.ASTERISM_REAL_CWD || app.getPath('temp');
    const id = await js(`window.__asterismTest.newPane(${JSON.stringify({ kind: 'claude', name: 'real', cwd, args: (process.env.ASTERISM_REAL_ARGS || '').split(' ').filter(Boolean) })})`);
    const started = await waitFor(() => manager.get(id).status.hooksSeen, 45000);
    check('real claude fires SessionStart', started, stateOf(id));
    await sleep(2500);
    await shot('real-01-started.png');
    // Accept the folder-trust dialog if it is showing.
    const screen = await js('window.__asterismTest.state().panes[0].screen');
    if (/trust/i.test(screen)) { manager.write(id, '\r'); await sleep(2000); }
    // Newline test: Shift+Enter equivalent (ESC CR) should not submit.
    manager.write(id, 'Reply with exactly the word PONG');
    await sleep(300);
    manager.write(id, '\r');
    const working = await waitFor(() => stateOf(id) === 'working', 15000);
    check('real UserPromptSubmit → working', working, stateOf(id));
    // Measure output cadence while working (validates the 30s stall heuristic).
    const gaps = [];
    let last = manager.get(id).status.lastOutputAt;
    const t0 = Date.now();
    while (stateOf(id) === 'working' && Date.now() - t0 < 60000) {
      await sleep(100);
      const now = manager.get(id).status.lastOutputAt;
      if (now !== last) { gaps.push(now - last); last = now; }
    }
    check('real Stop → ready', stateOf(id) === 'ready', { state: stateOf(id), reply: manager.get(id).status.lastReply });
    check('real last reply captured', /PONG/.test(manager.get(id).status.lastReply || ''), manager.get(id).status.lastReply);
    check('output cadence while working', true, { maxGapMs: Math.max(0, ...gaps), samples: gaps.length });
    results[results.length - 1].detail = { maxGapMs: Math.max(0, ...gaps), samples: gaps.length };
    await sleep(500);
    await shot('real-02-ready.png');
    manager.write(id, 'abc\x1b\rdef');
    await sleep(600);
    const scr = await js('window.__asterismTest.state().panes[0].screen');
    check('ESC CR inserts newline without submitting', stateOf(id) !== 'working' && /abc/.test(scr) && /def/.test(scr), scr.split('\n').slice(-12).join('\n'));
    await shot('real-03-newline.png');
    manager.write(id, '\x15\x15'); // clear input
  }
}

module.exports = { run };
