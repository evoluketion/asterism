// Colour themes. Each one sets the window chrome (CSS variables) and the terminal palette, so a
// pane's terminal background matches its frame. Status colours default to the palette's
// green / amber / red / blue so "ready" and "needs you" read the same way in every theme.

const XTERM_DEFAULT = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];

export const THEMES = [
  {
    id: 'asterism', label: 'Asterism', dark: true,
    bg: '#0b0e12', panel: '#12161c', panel2: '#181d25', panel3: '#222a36', line: '#262d38', lineStrong: '#3a4454',
    text: '#d7dde6', textStrong: '#ffffff', muted: '#8591a3', accent: '#6aa8ff', selection: '#2c4a77',
    ansi: ['#1b1f27', ...XTERM_DEFAULT.slice(1, 8), '#5c6677', ...XTERM_DEFAULT.slice(9)],
    st: { working: '#4a7fd6', ready: '#35d07f', permission: '#ffb224', error: '#ff5d5d', idle: '#343c48', exited: '#7a3434' },
  },
  {
    id: 'tokyo-night', label: 'Tokyo Night', dark: true,
    bg: '#16161e', panel: '#1a1b26', panel2: '#1f2335', panel3: '#292e42', line: '#292e42', lineStrong: '#3b4261',
    text: '#c0caf5', textStrong: '#ffffff', muted: '#737aa2', accent: '#7aa2f7', selection: '#283457',
    ansi: ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
      '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5'],
  },
  {
    id: 'catppuccin-mocha', label: 'Catppuccin Mocha', dark: true,
    bg: '#11111b', panel: '#1e1e2e', panel2: '#181825', panel3: '#313244', line: '#313244', lineStrong: '#45475a',
    text: '#cdd6f4', textStrong: '#ffffff', muted: '#9399b2', accent: '#89b4fa', selection: '#45475a',
    ansi: ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
      '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8'],
  },
  {
    id: 'dracula', label: 'Dracula', dark: true,
    bg: '#191a21', panel: '#282a36', panel2: '#21222c', panel3: '#343746', line: '#343746', lineStrong: '#44475a',
    text: '#f8f8f2', textStrong: '#ffffff', muted: '#8b95c4', accent: '#bd93f9', selection: '#44475a',
    ansi: ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff'],
  },
  {
    id: 'nord', label: 'Nord', dark: true,
    bg: '#242933', panel: '#2e3440', panel2: '#3b4252', panel3: '#434c5e', line: '#3b4252', lineStrong: '#4c566a',
    text: '#d8dee9', textStrong: '#eceff4', muted: '#8f9bb3', accent: '#88c0d0', selection: '#434c5e',
    ansi: ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4'],
  },
  {
    id: 'gruvbox-dark', label: 'Gruvbox Dark', dark: true,
    bg: '#1d2021', panel: '#282828', panel2: '#32302f', panel3: '#3c3836', line: '#3c3836', lineStrong: '#504945',
    text: '#ebdbb2', textStrong: '#fbf1c7', muted: '#a89984', accent: '#83a598', selection: '#504945',
    ansi: ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'],
  },
  {
    id: 'one-dark', label: 'One Dark', dark: true,
    bg: '#21252b', panel: '#282c34', panel2: '#2c313a', panel3: '#353b45', line: '#353b45', lineStrong: '#4b5263',
    text: '#abb2bf', textStrong: '#e6e9ef', muted: '#7f848e', accent: '#61afef', selection: '#3e4451',
    ansi: ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff'],
  },
  {
    id: 'rose-pine', label: 'Rosé Pine', dark: true,
    bg: '#191724', panel: '#1f1d2e', panel2: '#26233a', panel3: '#2a273f', line: '#26233a', lineStrong: '#403d52',
    text: '#e0def4', textStrong: '#ffffff', muted: '#908caa', accent: '#c4a7e7', selection: '#403d52',
    ansi: ['#26233a', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4',
      '#6e6a86', '#eb6f92', '#31748f', '#f6c177', '#9ccfd8', '#c4a7e7', '#ebbcba', '#e0def4'],
    st: { ready: '#7fd1a8', working: '#9ccfd8' },
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark', dark: true,
    bg: '#00212b', panel: '#002b36', panel2: '#073642', panel3: '#0b3f4d', line: '#073642', lineStrong: '#1b4f5c',
    text: '#93a1a1', textStrong: '#eee8d5', muted: '#6c8288', accent: '#268bd2', selection: '#0d4b5c',
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#586e75', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#fdf6e3'],
  },
  {
    id: 'solarized-light', label: 'Solarized Light', dark: false,
    bg: '#eee8d5', panel: '#fdf6e3', panel2: '#f5efdc', panel3: '#e8e1cb', line: '#ddd6c1', lineStrong: '#c9c1a9',
    text: '#4c5f66', textStrong: '#073642', muted: '#839496', accent: '#268bd2', selection: '#e3dcc6',
    ansi: ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#93a1a1',
      '#586e75', '#cb4b16', '#859900', '#b58900', '#268bd2', '#6c71c4', '#2aa198', '#657b83'],
  },
  {
    id: 'github-light', label: 'GitHub Light', dark: false,
    bg: '#f6f8fa', panel: '#ffffff', panel2: '#f6f8fa', panel3: '#eaeef2', line: '#d8dee4', lineStrong: '#c4ccd4',
    text: '#1f2328', textStrong: '#000000', muted: '#656d76', accent: '#0969da', selection: '#cfe3ff',
    ansi: ['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781',
      '#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f'],
    st: { ready: '#1a7f37', permission: '#bf8700', error: '#cf222e', working: '#0969da' },
  },
  {
    id: 'catppuccin-latte', label: 'Catppuccin Latte', dark: false,
    bg: '#dce0e8', panel: '#eff1f5', panel2: '#e6e9ef', panel3: '#ccd0da', line: '#ccd0da', lineStrong: '#bcc0cc',
    text: '#4c4f69', textStrong: '#11111b', muted: '#6c6f85', accent: '#1e66f5', selection: '#ccd0da',
    ansi: ['#5c5f77', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#acb0be',
      '#6c6f85', '#d20f39', '#40a02b', '#df8e1d', '#1e66f5', '#ea76cb', '#179299', '#bcc0cc'],
  },
];

export function getTheme(id) {
  return THEMES.find(t => t.id === id) || THEMES[0];
}

// The status colours: the theme's own, else taken from its palette.
function statusColors(t) {
  const a = t.ansi;
  return {
    working: a[4], ready: t.dark ? a[10] : a[2], permission: t.dark ? a[11] : a[3], error: t.dark ? a[9] : a[1],
    idle: t.lineStrong, exited: `color-mix(in srgb, ${a[1]} 50%, ${t.panel})`,
    ...(t.st || {}),
  };
}

export function cssVars(t) {
  const st = statusColors(t);
  return {
    '--bg': t.bg, '--panel': t.panel, '--panel-2': t.panel2, '--panel-3': t.panel3,
    '--line': t.line, '--line-strong': t.lineStrong,
    '--text': t.text, '--text-strong': t.textStrong, '--muted': t.muted, '--accent': t.accent,
    '--name-dim': `color-mix(in srgb, ${t.text} 80%, ${t.panel})`,
    '--st-working': st.working, '--st-ready': st.ready, '--st-permission': st.permission, '--st-question': st.permission,
    '--st-error': st.error, '--st-idle': st.idle, '--st-shell': st.idle, '--st-starting': st.idle, '--st-exited': st.exited,
  };
}

const ANSI_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

export function termTheme(t) {
  const theme = {
    background: t.panel, foreground: t.text, cursor: t.text, cursorAccent: t.panel,
    selectionBackground: t.selection,
  };
  ANSI_NAMES.forEach((n, i) => { theme[n] = t.ansi[i]; });
  return theme;
}
