'use strict';
/**
 * settings.js —— 设置界面
 *
 * 九个板块：系统 / 显示 / 右键菜单 / 交互 / 主题 / 收纳窗 / 中转站 / Dock 栏 / 更新
 */

/* 控件工厂来自 common/ui.js（在页面脚本之前加载，函数已在全局作用域） */

/** 纯图标按钮 */
function iconButton(iconName, onClick, kind) {
  const node = button('', onClick, `sm icon ${kind || ''}`.trim());
  node.appendChild(ico(iconName, 14));
  return node;
}

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

const S = {
  boot: null,
  config: null,
  strings: {},
  section: 'system',
  items: [],
  presets: ['#2563EB', '#0EA5E9', '#14B8A6', '#22C55E', '#EAB308', '#F97316', '#EF4444', '#EC4899', '#8B5CF6', '#64748B'],
  themeTarget: 'organizer',
  dirtyStorage: {}
};

const SECTION_IDS = [
  'system',
  'display',
  'contextMenu',
  'interaction',
  'theme',
  'organizers',
  'stations',
  'docks',
  'update'
];

function T(key, p1, p2, p3) {
  let text = S.strings[key];
  if (text === undefined) return key;
  const params = [p1, p2, p3];
  return String(text).replace(/\{(\d)\}/g, (m, i) => (params[Number(i)] !== undefined ? String(params[Number(i)]) : m));
}

async function patch(section, values) {
  const res = await window.tuck.settings.patch(section, values);
  if (res && res.ok) {
    S.config = res.config;
  } else {
    toast(T('toast.failed', res && res.error ? res.error : ''), 'err');
  }
  return res;
}

function setConfig(next) {
  S.config = next;
  S.items = next.items || [];
}

/* ------------------------------------------------------------------ *
 * 导航
 * ------------------------------------------------------------------ */

const SECTIONS = [
  { id: 'system', icon: 'system', key: 'nav.system' },
  { id: 'display', icon: 'display', key: 'nav.display' },
  { id: 'contextMenu', icon: 'menu', key: 'nav.contextMenu' },
  { id: 'interaction', icon: 'interaction', key: 'nav.interaction' },
  { id: 'theme', icon: 'theme', key: 'nav.theme' },
  { id: 'organizers', icon: 'organizer', key: 'nav.organizers' },
  { id: 'stations', icon: 'station', key: 'nav.stations' },
  { id: 'docks', icon: 'dock', key: 'nav.docks' },
  { id: 'update', icon: 'update', key: 'nav.update' }
];

function counts(section) {
  if (section === 'organizers') return S.items.filter((i) => i.kind === 'organizer').length;
  if (section === 'stations') return S.items.filter((i) => i.kind === 'station').length;
  if (section === 'docks') return S.items.filter((i) => i.kind === 'dock').length;
  return null;
}

function renderNav() {
  const host = document.getElementById('nav-list');
  host.textContent = '';
  SECTIONS.forEach((sec) => {
    const n = counts(sec.id);
    const btn = el('button', {
      class: `nav-item${S.section === sec.id ? ' active' : ''}`,
      type: 'button',
      onClick: () => {
        S.section = sec.id;
        try {
          localStorage.setItem('tuckdesk.section', sec.id);
        } catch (_) {
          /* 忽略 */
        }
        renderNav();
        renderPage();
      }
    }, [
      el('span', { class: 'ico' }, [ico(sec.icon)]),
      el('span', { class: 'label', text: T(sec.key) }),
      n ? el('span', { class: 'count', text: String(n) }) : null
    ]);
    host.appendChild(btn);
  });
}

/* ------------------------------------------------------------------ *
 * 页面分发
 * ------------------------------------------------------------------ */

function renderPage() {
  const page = document.getElementById('page');
  page.textContent = '';
  const builders = {
    system: buildSystem,
    display: buildDisplay,
    contextMenu: buildContextMenu,
    interaction: buildInteraction,
    theme: buildTheme,
    organizers: buildOrganizers,
    stations: buildStations,
    docks: buildDocks,
    update: buildUpdate
  };
  const node = builders[S.section]();
  if (node) page.appendChild(node);
}

function head(key, subKey) {
  return pageHead(T(key), T(subKey));
}

/* ------------------------------------------------------------------ *
 * 1. 系统
 * ------------------------------------------------------------------ */

function buildSystem() {
  const sys = S.config.system;
  const frag = document.createDocumentFragment();
  frag.appendChild(head('system.title', 'system.subtitle'));

  /* 启动与右键菜单 */
  const startupToggle = toggle(sys.launchAtStartup, async (v) => {
    const res = await window.tuck.shell.setStartup(v);
    if (res && res.ok) {
      sys.launchAtStartup = v;
      toast(T('toast.saved'), 'ok');
    } else {
      startupToggle.set(!v);
      toast(T('toast.failed', (res && res.detail) || ''), 'err');
    }
  });

  const folderToggle = toggle(sys.folderContextMenu, async (v) => {
    const res = await window.tuck.shell.setContextMenu('folder', v);
    if (res && res.ok) {
      sys.folderContextMenu = v;
      refreshMenuStates();
    } else {
      folderToggle.set(!v);
      toast(T('toast.failed', (res && res.detail) || ''), 'err');
    }
  });

  const desktopToggle = toggle(sys.desktopContextMenu, async (v) => {
    const res = await window.tuck.shell.setContextMenu('desktop', v);
    if (res && res.ok) {
      sys.desktopContextMenu = v;
      refreshMenuStates();
    } else {
      desktopToggle.set(!v);
      toast(T('toast.failed', (res && res.detail) || ''), 'err');
    }
  });

  const folderState = el('span', { class: 'badge', id: 'folder-state' });
  const desktopState = el('span', { class: 'badge', id: 'desktop-state' });
  folderToggle.nodes[0].dataset.menuToggle = 'folderContextMenu';
  desktopToggle.nodes[0].dataset.menuToggle = 'desktopContextMenu';

  frag.appendChild(
    card(T('system.groupStartup'), [
      row(T('system.startup'), T('system.startupDesc'), startupToggle),
      el('div', { class: 'row' }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title' }, [document.createTextNode(T('system.folderMenu')), folderState]),
          el('div', { class: 'row-desc', text: T('system.folderMenuDesc') })
        ]),
        el('div', { class: 'row-control' }, [
          button(T('system.menuRepair'), async () => {
            const res = await window.tuck.shell.setContextMenu('folder', true);
            if (res && res.ok) {
              folderToggle.set(true);
              sys.folderContextMenu = true;
              refreshMenuStates();
              toast(T('toast.saved'), 'ok');
            } else {
              toast(T('toast.failed', (res && res.detail) || ''), 'err');
            }
          }, 'sm'),
          folderToggle.nodes[0]
        ])
      ]),
      el('div', { class: 'row' }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title' }, [document.createTextNode(T('system.desktopMenu')), desktopState]),
          el('div', { class: 'row-desc', text: T('system.desktopMenuDesc') })
        ]),
        el('div', { class: 'row-control' }, [
          button(T('system.menuRepair'), async () => {
            const res = await window.tuck.shell.setContextMenu('desktop', true);
            if (res && res.ok) {
              desktopToggle.set(true);
              sys.desktopContextMenu = true;
              refreshMenuStates();
              toast(T('toast.saved'), 'ok');
            } else {
              toast(T('toast.failed', (res && res.detail) || ''), 'err');
            }
          }, 'sm'),
          desktopToggle.nodes[0]
        ])
      ])
    ])
  );

  /* 性能 + 语言 */
  const perfCards = el('div', { class: 'radio-cards' });
  (S.boot.performanceProfiles || []).forEach((p) => {
    const node = el('div', {
      class: `radio-card${sys.performanceProfile === p.id ? ' active' : ''}`,
      onClick: async () => {
        [...perfCards.children].forEach((c) => c.classList.remove('active'));
        node.classList.add('active');
        await patch('system', { performanceProfile: p.id });
        sys.performanceProfile = p.id;
      }
    }, [el('div', { class: 't', text: p.label }), el('div', { class: 'd', text: p.desc })]);
    perfCards.appendChild(node);
  });

  const langSelect = select(
    (S.boot.languages || []).map((l) => ({ id: l.id, label: l.label })),
    sys.language,
    async (v) => {
      const res = await window.tuck.setLanguage(v);
      if (res && res.ok) {
        S.strings = res.strings;
        S.config.system.language = res.language;
        renderNav();
        renderPage();
        toast(T('toast.saved'), 'ok');
      }
    }
  );

  frag.appendChild(
    card(T('system.groupPerformance'), [
      el('div', { class: 'row stack' }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title', text: T('system.performance') }),
          el('div', { class: 'row-desc', text: T('system.performanceDesc') })
        ]),
        perfCards
      ]),
      row(T('system.language'), null, langSelect)
    ])
  );

  /* 默认存储路径 */
  const storageLabel = el('div', {
    class: 'row-desc',
    style: { fontFamily: 'var(--mono)', wordBreak: 'break-all' },
    text: sys.defaultStoragePath
      ? T('system.storageCurrent', sys.defaultStoragePath)
      : T('system.storageAuto', S.boot.defaultStorageRoot)
  });

  frag.appendChild(
    card(T('system.storage'), [
      el('div', { class: 'row' }, [
        el('div', { class: 'row-main' }, [
          storageLabel,
          el('div', { class: 'row-desc', text: T('system.storageDesc') })
        ]),        el('div', { class: 'row-control' }, [
          button(T('common.browse'), async () => {
            const picked = await window.tuck.settings.pickFolder({
              title: T('system.storage'),
              defaultPath: sys.defaultStoragePath || S.boot.defaultStorageRoot
            });
            if (!picked || !picked.ok) return;
            const res = await window.tuck.settings.setDefaultStorage(picked.path);
            if (res && res.ok) {
              sys.defaultStoragePath = picked.path === S.boot.defaultStorageRoot ? '' : picked.path;
              storageLabel.textContent = sys.defaultStoragePath
                ? T('system.storageCurrent', sys.defaultStoragePath)
                : T('system.storageAuto', S.boot.defaultStorageRoot);
              toast(T('system.storageChanged'), 'ok');
            } else {
              toast(T('toast.failed', res && res.reason ? res.reason : ''), 'err');
            }
          }),
          button(T('common.reset'), async () => {
            const res = await window.tuck.settings.setDefaultStorage(null);
            if (res && res.ok) {
              sys.defaultStoragePath = '';
              storageLabel.textContent = T('system.storageAuto', res.path);
              toast(T('system.storageReset'), 'ok');
            }
          })
        ])
      ])
    ])
  );

  /* 本地诊断 */
  frag.appendChild(
    card(T('system.diagnostics'), [
      el('div', { class: 'row stack' }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title', text: T('system.diagnostics') }),
          el('div', { class: 'row-desc', text: T('system.diagnosticsDesc') })
        ]),
        el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
          button(T('system.diagnosticsExport'), async () => {
            const res = await window.tuck.settings.exportDiagnostics();
            if (!res || res.canceled) return;
            if (res.ok) toast(T('system.diagnosticsExported', res.path), 'ok', 5200);
            else toast(T('system.diagnosticsFailed', res.error || ''), 'err', 5200);
          }, 'primary'),
          button(T('system.diagnosticsOpenFolder'), () => window.tuck.settings.openPath(S.boot.dataRoot), 'ghost')
        ])
      ]),
      el('div', { class: 'row stack' }, [
        el('div', { class: 'kv' }, [
          el('div', { class: 'k', text: T('about.dataRoot') }),
          el('div', { class: 'v', text: S.boot.dataRoot }),
          el('div', { class: 'k', text: T('common.path') }),
          el('div', { class: 'v', text: S.boot.configPath })
        ])
      ])
    ])
  );

  setTimeout(refreshMenuStates, 0);

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

async function refreshMenuStates() {
  const states = await window.tuck.shell.menuStates();
  const f = document.getElementById('folder-state');
  const d = document.getElementById('desktop-state');
  const apply = (node, state) => {
    if (!node) return;
    const map = {
      enabled: ['badge ok', T('system.menuStateOn')],
      disabled: ['badge', T('system.menuStateOff')],
      broken: ['badge warn', T('system.menuStateBroken')],
      other: ['badge warn', T('system.menuStateBroken')]
    };
    const [cls, text] = map[state] || map.disabled;
    node.className = cls;
    node.textContent = text;
    node.style.marginLeft = '8px';
    node.style.fontWeight = '400';
  };
  apply(f, states.folder);
  apply(d, states.desktop);

  /* 开关以注册表的真实状态为准：配置可能来自迁移，或注册表被外部清理过，
     两者不一致时界面会自相矛盾（开关是开、徽标说未启用） */
  const syncToggle = (section, state) => {
    const want = state === 'enabled';
    if (S.config.system[section] === want) return;
    S.config.system[section] = want;
    const box = document.querySelector(`[data-menu-toggle="${section}"] input`);
    if (box) box.checked = want;
  };
  syncToggle('folderContextMenu', states.folder);
  syncToggle('desktopContextMenu', states.desktop);
}

/* ------------------------------------------------------------------ *
 * 2. 显示
 * ------------------------------------------------------------------ */

function buildDisplay() {
  const d = S.config.display;
  const frag = document.createDocumentFragment();
  frag.appendChild(head('display.title', 'display.subtitle'));

  const pct = (v) => `${Math.round(v * 100)}%`;

  const compact = slider(d.compactNameScale, 0.6, 1, 0.05, pct, (v) => {
    d.compactNameScale = v;
    patch('display', { compactNameScale: v });
  });
  const expanded = slider(d.expandedNameScale, 0.6, 1, 0.05, pct, (v) => {
    d.expandedNameScale = v;
    patch('display', { expandedNameScale: v });
  });
  const uniform = slider(d.uniformEntrySize, 0.6, 1.4, 0.05, pct, (v) => {
    d.uniformEntrySize = v;
    patch('display', { uniformEntrySize: v });
  });

  frag.appendChild(
    card(T('display.groupAppearance'), [
      row(T('display.hideCollapseIndicator'), T('display.hideCollapseIndicatorDesc'),
        toggle(d.hideCollapseIndicator, (v) => patch('display', { hideCollapseIndicator: v }))),
      row(T('display.edgeGlow'), T('display.edgeGlowDesc'),
        toggle(d.edgeGlow, (v) => patch('display', { edgeGlow: v }))),
      row(T('display.showItemCount'), null,
        toggle(d.showItemCount, (v) => patch('display', { showItemCount: v }))),
      row(T('display.trayIcon'), null,
        toggle(d.trayIcon, (v) => patch('display', { trayIcon: v })))
    ])
  );

  frag.appendChild(
    card(T('display.groupLayer'), [
      row(T('display.noteAlwaysOnTop'), T('display.noteAlwaysOnTopDesc'),
        toggle(d.noteAlwaysOnTop, (v) => patch('display', { noteAlwaysOnTop: v })))
    ])
  );

  frag.appendChild(
    card(T('display.groupSize'), [
      row(T('display.compactNameScale'), null, compact),
      row(T('display.expandedNameScale'), null, expanded),
      row(T('display.uniformEntrySize'), T('display.uniformEntrySizeDesc'), uniform)
    ])
  );

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * 3. 右键菜单
 * ------------------------------------------------------------------ */

const CONTEXT_ITEMS = [
  { key: 'addItem', group: 'groupItem' },
  { key: 'newFolder', group: 'groupItem' },
  { key: 'newNote', group: 'groupItem' },
  { key: 'newTodo', group: 'groupItem' },
  { key: 'paste', group: 'groupItem' },
  { key: 'remove', group: 'groupItem' },
  { key: 'rename', group: 'groupWindow' },
  { key: 'duplicate', group: 'groupWindow' },
  { key: 'togglePlacement', group: 'groupWindow' },
  { key: 'toggleContent', group: 'groupWindow' },
  { key: 'toggleExpansion', group: 'groupWindow' },
  { key: 'hideName', group: 'groupWindow' },
  { key: 'openStorage', group: 'groupSystem' },
  { key: 'settings', group: 'groupSystem' }
];

function buildContextMenu() {
  const cm = S.config.contextMenu;
  const frag = document.createDocumentFragment();
  frag.appendChild(head('contextMenu.title', 'contextMenu.subtitle'));
  frag.appendChild(el('div', { class: 'sec-note' }, [
    el('span', { style: { flex: 'none', display: 'grid', placeItems: 'center' } }, [ico('info', 16)]),
    el('span', { text: T('contextMenu.desc') })
  ]));

  const groups = ['groupItem', 'groupWindow', 'groupSystem'];
  groups.forEach((g) => {
    const rows = CONTEXT_ITEMS.filter((it) => it.group === g).map((it) =>
      row(T(`ctx.${it.key}`), T(`ctx.${it.key}.desc`), toggle(cm[it.key], (v) => {
        cm[it.key] = v;
        patch('contextMenu', { [it.key]: v });
      }))
    );
    frag.appendChild(card(T(`contextMenu.${g}`), rows));
  });

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * 4. 交互
 * ------------------------------------------------------------------ */

function buildInteraction() {
  const it = S.config.interaction;
  const frag = document.createDocumentFragment();
  frag.appendChild(head('interaction.title', 'interaction.subtitle'));

  const ms = (v) => T('interaction.unit.ms', Math.round(v));
  const dip = (v) => T('interaction.unit.dip', Math.round(v));

  frag.appendChild(
    card(T('interaction.groupExpand'), [
      row(T('interaction.collapseOutside'), T('interaction.collapseOutside.desc'),
        toggle(it.collapseOutside, (v) => patch('interaction', { collapseOutside: v }))),
      row(T('interaction.expandOnHover'), T('interaction.expandOnHover.desc'),
        toggle(it.expandOnHover, (v) => patch('interaction', { expandOnHover: v }))),
      row(T('interaction.collapseOnPointerLeave'), null,
        toggle(it.collapseOnPointerLeave, (v) => patch('interaction', { collapseOnPointerLeave: v }))),
      row(T('interaction.hoverExpandDelay'), null,
        slider(it.hoverExpandDelay, 0, 2000, 20, ms, (v) => patch('interaction', { hoverExpandDelay: v }))),
      row(T('interaction.pointerLeaveCollapseDelay'), null,
        slider(it.pointerLeaveCollapseDelay, 0, 2000, 20, ms, (v) => patch('interaction', { pointerLeaveCollapseDelay: v }))),
      row(T('interaction.exclusiveExpansion'), T('interaction.exclusiveExpansion.desc'),
        toggle(it.exclusiveExpansion, (v) => patch('interaction', { exclusiveExpansion: v })))
    ])
  );

  frag.appendChild(
    card(T('interaction.groupStation'), [
      row(T('interaction.stationActivationDistance'), null,
        slider(it.stationActivationDistance, 0, 200, 2, dip, (v) => patch('interaction', { stationActivationDistance: v }))),
      row(T('interaction.stationHoverDelay'), null,
        slider(it.stationHoverDelay, 0, 2000, 20, ms, (v) => patch('interaction', { stationHoverDelay: v }))),
      row(T('interaction.stationCollapseDelay'), null,
        slider(it.stationCollapseDelay, 0, 3000, 20, ms, (v) => patch('interaction', { stationCollapseDelay: v })))
    ])
  );

  frag.appendChild(
    card(T('interaction.groupDrag'), [
      row(T('interaction.windowAlignment'), T('interaction.windowAlignment.desc'),
        toggle(it.windowAlignment, (v) => patch('interaction', { windowAlignment: v }))),
      row(T('interaction.rememberExpandedPosition'), T('interaction.rememberExpandedPosition.desc'),
        toggle(it.rememberExpandedPosition, (v) => patch('interaction', { rememberExpandedPosition: v })))
    ])
  );

  frag.appendChild(
    card(T('interaction.groupHover'), [
      row(T('interaction.compactHoverMagnification'), null,
        toggle(it.compactHoverMagnification, (v) => patch('interaction', { compactHoverMagnification: v }))),
      row(T('interaction.dockHoverMagnification'), null,
        toggle(it.dockHoverMagnification, (v) => patch('interaction', { dockHoverMagnification: v }))),
      row(T('interaction.hoverMagnificationScale'), null,
        slider(it.hoverMagnificationScale, 1, 1.6, 0.05, (v) => `${v.toFixed(2)}×`,
          (v) => patch('interaction', { hoverMagnificationScale: v })))
    ])
  );

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * 5. 主题
 * ------------------------------------------------------------------ */

function buildTheme() {
  const frag = document.createDocumentFragment();
  frag.appendChild(head('theme.title', 'theme.subtitle'));

  const targets = [
    { id: 'organizer', key: 'theme.target.organizer' },
    { id: 'station', key: 'theme.target.station' },
    { id: 'dock', key: 'theme.target.dock' },
    { id: 'settings', key: 'theme.target.settings' }
  ];

  const targetSeg = segmented(
    targets.map((t) => ({ id: t.id, label: T(t.key) })),
    S.themeTarget,
    (v) => {
      S.themeTarget = v;
      renderPage();
    }
  );

  frag.appendChild(card(null, [row(T('theme.target'), null, targetSeg)]));

  const entry = S.config.theme[S.themeTarget];
  const holder = el('div');

  /* 预览 */
  const previewTile = el('div', { class: 'pv-tile' + (entry.mode === 'glass' ? ' glass' : ''), text: T('theme.previewText') });
  const preview = el('div', { class: 'theme-preview' }, [previewTile]);

  function paintPreview() {
    const alpha = entry.mode === 'glass' ? Math.min(1, entry.opacity) : entry.opacity;
    previewTile.style.background = rgba(entry.color, alpha);
    previewTile.style.color = luminance(entry.color) > 0.6 ? '#111827' : '#ffffff';
    previewTile.style.backdropFilter = entry.mode === 'glass' ? `blur(${6 + (entry.blur / 60) * 22}px) saturate(150%)` : 'none';
    previewTile.className = `pv-tile${entry.mode === 'glass' ? ' glass' : ''}`;
  }

  /* 色板 */
  const swatches = el('div', { class: 'swatches' });
  const allPresets = S.presets.includes(entry.color) ? S.presets : [...S.presets, entry.color];
  allPresets.forEach((c) => {
    const isPreset = S.presets.includes(c);
    const sw = el('div', {
      class: `swatch${c === entry.color && isPreset ? ' active' : ''}`,
      style: { background: c },
      title: c,
      onClick: () => {
        entry.color = c.toUpperCase();
        setRgbFromHex();
        [...swatches.children].forEach((x) => x.classList.remove('active'));
        sw.classList.add('active');
        paintPreview();
        patch('theme', { [S.themeTarget]: entry });
      }
    });
    swatches.appendChild(sw);
  });
  const customSw = el('div', {
    class: `swatch custom${S.presets.includes(entry.color) ? '' : ' active'}`,
    title: T('theme.custom'),
    onClick: () => {
      [...swatches.children].forEach((x) => x.classList.remove('active'));
      customSw.classList.add('active');
      document.getElementById('custom-color-box').style.display = '';
    }
  }, [el('span')]);
  swatches.appendChild(customSw);

  /* RGB 自定义 */
  const rgb = hexToRgb(entry.color);
  const rIn = el('input', { type: 'number', min: '0', max: '255', value: String(rgb.r) });
  const gIn = el('input', { type: 'number', min: '0', max: '255', value: String(rgb.g) });
  const bIn = el('input', { type: 'number', min: '0', max: '255', value: String(rgb.b) });
  const hexIn = el('input', { type: 'text', value: entry.color, maxlength: '7' });

  function setRgbFromHex() {
    const c = hexToRgb(entry.color);
    rIn.value = String(c.r);
    gIn.value = String(c.g);
    bIn.value = String(c.b);
    hexIn.value = entry.color;
  }

  function commitRgb() {
    const next = rgbToHex(Number(rIn.value) || 0, Number(gIn.value) || 0, Number(bIn.value) || 0);
    entry.color = next;
    hexIn.value = next;
    [...swatches.children].forEach((x) => x.classList.remove('active'));
    customSw.classList.add('active');
    paintPreview();
    patch('theme', { [S.themeTarget]: entry });
  }
  [rIn, gIn, bIn].forEach((inp) => inp.addEventListener('change', commitRgb));
  hexIn.addEventListener('change', () => {
    const v = hexIn.value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
      entry.color = (v.startsWith('#') ? v : `#${v}`).toUpperCase();
      setRgbFromHex();
      commitRgb();
    } else {
      setRgbFromHex();
    }
  });

  const customBox = el('div', {
    id: 'custom-color-box',
    style: { display: S.presets.includes(entry.color) ? 'none' : '' }
  }, [
    el('div', { class: 'rgb-grid' }, [
      el('div', { class: 'ch', text: 'R' }), rIn, el('div', { class: 'hint', text: T('theme.red') }),
      el('div', { class: 'ch', text: 'G' }), gIn, el('div', { class: 'hint', text: T('theme.green') }),
      el('div', { class: 'ch', text: 'B' }), bIn, el('div', { class: 'hint', text: T('theme.blue') })
    ]),
    el('div', { class: 'hex-row', style: { marginTop: '10px' } }, [
      el('span', { class: 'hint', text: T('theme.hex') }),
      hexIn
    ])
  ]);

  /* 背景模式 */
  const modeSeg = segmented(
    [
      { id: 'glass', label: T('theme.mode.glass') },
      { id: 'solid', label: T('theme.mode.solid') }
    ],
    entry.mode,
    (v) => {
      entry.mode = v;
      paintPreview();
      patch('theme', { [S.themeTarget]: entry });
    }
  );

  /* 不透明度与模糊 */
  const opacitySlider = slider(entry.opacity, 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => {
    entry.opacity = v;
    paintPreview();
    patch('theme', { [S.themeTarget]: entry });
  });
  const blurSlider = slider(entry.blur, 0, 60, 1, (v) => `${Math.round((v / 60) * 100)}%`, (v) => {
    entry.blur = v;
    paintPreview();
    patch('theme', { [S.themeTarget]: entry });
  });
  const blurRow = row(T('theme.blur'), T('theme.blurDesc'), blurSlider);
  const syncBlurVisibility = () => {
    blurRow.style.opacity = entry.mode === 'glass' ? '1' : '0.45';
    blurRow.style.pointerEvents = entry.mode === 'glass' ? '' : 'none';
  };

  paintPreview();
  syncBlurVisibility();

  holder.appendChild(
    card(T('theme.preview'), [el('div', { style: { padding: '4px 0 10px' } }, [preview])])
  );
  holder.appendChild(
    card(T('theme.color'), [
      el('div', { class: 'row stack' }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-desc', text: T('theme.customColor') })
        ]),
        swatches,
        customBox
      ])
    ])
  );
  holder.appendChild(
    card(T('theme.groupBackground'), [
      row(T('theme.mode'), null, modeSeg),
      row(T('theme.opacity'), T('theme.opacityDesc'), opacitySlider),
      blurRow
    ])
  );

  const resetBtn = button(T('theme.resetTarget'), async () => {
    const defaults = {
      organizer: { color: '#3B82F6', mode: 'glass', opacity: 0.82, blur: 28 },
      station: { color: '#8B5CF6', mode: 'glass', opacity: 0.82, blur: 28 },
      dock: { color: '#0EA5E9', mode: 'glass', opacity: 0.82, blur: 28 },
      settings: { color: '#2563EB', mode: 'solid', opacity: 1, blur: 24 }
    };
    await patch('theme', { [S.themeTarget]: defaults[S.themeTarget] });
    renderPage();
    toast(T('toast.saved'), 'ok');
  });
  holder.appendChild(el('div', { style: { marginTop: '14px', display: 'flex', gap: '8px' } }, [resetBtn]));

  frag.appendChild(holder);

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/* ------------------------------------------------------------------ *
 * 6/7/8. 收纳窗 / 中转站 / Dock 栏
 * ------------------------------------------------------------------ */

function itemCard(item) {
  const kindIcon = item.kind === 'organizer' ? 'organizer' : item.kind === 'station' ? 'station' : 'dock';
  const subParts = [item.storagePath];
  if (item.kind === 'organizer') {
    subParts.push(item.placement === 'floating' ? T('org.mode.floating') : T('org.mode.positioned'));
    subParts.push(T('org.gridFormat', item.columns, item.rows));
  } else if (item.kind === 'station') {
    subParts.push(T(`station.edge.${item.edge}`));
    subParts.push(T('org.gridFormat', item.columns, item.rows));
  } else {
    subParts.push(item.orientation === 'horizontal' ? T('dock.orientation.horizontal') : T('dock.orientation.vertical'));
    subParts.push(`${item.iconSize} / ${item.spacing}`);
  }

  return el('div', { class: 'item-card' }, [
    el('div', { class: 'ic' }, [ico(kindIcon, 18)]),
    el('div', { class: 'meta' }, [
      el('div', { class: 'nm' }, [
        el('span', { text: item.name }),
        item.visible ? null : el('span', { class: 'badge', text: T('manage.hide') })
      ]),
      el('div', { class: 'sub', text: subParts.filter(Boolean).join('  ·  ') })
    ]),
    el('div', { class: 'acts' }, [
      button(T('manage.open'), () => window.tuck.items.activate(item.id), 'sm'),
      button(T('manage.openFolder'), () => window.tuck.items.openStorage(item.id), 'sm'),
      iconButton('edit', async () => {
        const v = await promptDialog(T('common.rename'), item.name);
        if (v === null) return;
        const res = await window.tuck.items.update(item.id, { name: v.trim() });
        if (res && res.ok) {
          await reloadItems();
          renderPage();
        } else {
          toast(T('org.nameRequired'), 'err');
        }
      }),
      iconButton('trash', async () => {
        // 保存在目录里的内容由主进程询问如何处理（移到桌面 / 留在原路径）
        const res = await window.tuck.items.remove(item.id, {});
        if (res && res.canceled) return;
        if (res && res.ok) {
          if (res.message) toast(res.message, 'ok', 4600);
          await reloadItems();
          renderPage();
        } else {
          toast((res && res.message) || T('toast.failed', (res && res.reason) || ''), 'err', 4600);
        }
      }, 'danger')
    ])
  ]);
}

async function reloadItems() {
  const boot = await window.tuck.bootstrap();
  S.boot = boot;
  setConfig(boot.config);
}

function buildOrganizers() {
  const frag = document.createDocumentFragment();
  frag.appendChild(head('org.title', 'org.subtitle'));
  frag.appendChild(buildAddForm('organizer'));

  const list = S.items.filter((i) => i.kind === 'organizer');
  const listCard = card(
    T('org.listTitle'),
    list.length
      ? [el('div', { class: 'item-list', style: { padding: '8px 0' } }, list.map(itemCard))]
      : [el('div', { class: 'empty', text: T('org.empty') })],
    el('span', { class: 'badge accent', text: String(list.length) })
  );
  frag.appendChild(listCard);

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

function buildStations() {
  const frag = document.createDocumentFragment();
  frag.appendChild(head('station.title', 'station.subtitle'));
  frag.appendChild(buildAddForm('station'));

  const list = S.items.filter((i) => i.kind === 'station');
  frag.appendChild(
    card(
      T('station.listTitle'),
      list.length
        ? [el('div', { class: 'item-list', style: { padding: '8px 0' } }, list.map(itemCard))]
        : [el('div', { class: 'empty', text: T('station.empty') })],
      el('span', { class: 'badge accent', text: String(list.length) })
    )
  );

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

function buildDocks() {
  const frag = document.createDocumentFragment();
  frag.appendChild(head('dock.title', 'dock.subtitle'));
  frag.appendChild(buildAddForm('dock'));

  const list = S.items.filter((i) => i.kind === 'dock');
  frag.appendChild(
    card(
      T('dock.listTitle'),
      list.length
        ? [el('div', { class: 'item-list', style: { padding: '8px 0' } }, list.map(itemCard))]
        : [el('div', { class: 'empty', text: T('dock.empty') })],
      el('span', { class: 'badge accent', text: String(list.length) })
    )
  );

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

/** 新建窗口表单 */
function buildAddForm(kind) {
  const state = {
    name: '',
    storagePath: '',
    placement: 'floating',
    expansion: 'collapsible',
    contentMode: 'icon',
    rows: 3,
    columns: 4,
    edge: 'left',
    orientation: 'horizontal',
    iconSize: 48,
    spacing: 12,
    displayId: null
  };
  const grid = el('div', { class: 'form-grid' });

  /* 名称 */
  const nameInput = el('input', { type: 'text', placeholder: T('common.namePlaceholder') });
  nameInput.addEventListener('input', () => {
    state.name = nameInput.value;
  });
  grid.appendChild(el('div', { class: 'field full' }, [el('label', { text: T('common.name') }), nameInput]));

  /* 保存位置 */
  const pathInput = el('input', { type: 'text', placeholder: T('system.storageAuto', S.boot.defaultStorageRoot), readonly: true });
  const pickBtn = button(T('common.browse'), async () => {
    const res = await window.tuck.items.pickStorage({
      defaultPath: S.boot.effectiveStorageRoot,
      exceptId: null
    });
    if (res && res.ok) {
      state.storagePath = res.path;
      pathInput.value = res.path;
    } else if (res && res.reason) {
      toast(T('toast.failed', res.reason), 'err');
    }
  });
  grid.appendChild(
    el('div', { class: 'field full' }, [
      el('label', { text: T('common.path') }),
      el('div', { class: 'with-btn' }, [pathInput, pickBtn])
    ])
  );

  if (kind === 'organizer' || kind === 'station') {
    /* 模式（仅收纳窗） */
    if (kind === 'organizer') {
      const modeCards = el('div', { class: 'radio-cards' });
      [
        { id: 'floating', t: T('org.mode.floating'), d: T('org.mode.desc.floating') },
        { id: 'positioned', t: T('org.mode.positioned'), d: T('org.mode.desc.positioned') }
      ].forEach((m) => {
        const n = el('div', {
          class: `radio-card${state.placement === m.id ? ' active' : ''}`,
          onClick: () => {
            state.placement = m.id;
            [...modeCards.children].forEach((c) => c.classList.remove('active'));
            n.classList.add('active');
          }
        }, [el('div', { class: 't', text: m.t }), el('div', { class: 'd', text: m.d })]);
        modeCards.appendChild(n);
      });
      grid.appendChild(el('div', { class: 'field full' }, [el('label', { text: T('org.mode') }), modeCards]));
    }

    /* 展开行为 */
    const expSeg = segmented(
      [
        { id: 'collapsible', label: T('org.expansion.collapsible') },
        { id: 'alwaysExpanded', label: T('org.expansion.alwaysExpanded') }
      ],
      state.expansion,
      (v) => {
        state.expansion = v;
      }
    );
    grid.appendChild(el('div', { class: 'field' }, [el('label', { text: T('org.expansion') }), expSeg.nodes[0]]));

    /* 内容展开方式 */
    const contentSeg = segmented(
      [
        { id: 'icon', label: T('org.contentMode.icon') },
        { id: 'compactList', label: T('org.contentMode.compactList') }
      ],
      state.contentMode,
      (v) => {
        state.contentMode = v;
      }
    );
    grid.appendChild(el('div', { class: 'field' }, [el('label', { text: T('org.contentMode') }), contentSeg.nodes[0]]));
  }

  if (kind === 'station') {
    /* 显示器靠边 */
    const edgeOptions = ['left', 'top', 'right', 'bottom'].map((e) => ({ id: e, label: T(`station.edge.${e}`) }));
    const edgeSeg = segmented(edgeOptions, state.edge, (v) => {
      state.edge = v;
    });
    grid.appendChild(el('div', { class: 'field full' }, [el('label', { text: T('station.edge') }), edgeSeg.nodes[0]]));
  }

  if (kind === 'dock') {
    const oriSeg = segmented(
      [
        { id: 'horizontal', label: T('dock.orientation.horizontal') },
        { id: 'vertical', label: T('dock.orientation.vertical') }
      ],
      state.orientation,
      (v) => {
        state.orientation = v;
      }
    );
    grid.appendChild(el('div', { class: 'field' }, [el('label', { text: T('dock.orientation') }), oriSeg.nodes[0]]));

    const iconSlider = slider(state.iconSize, 24, 96, 2, (v) => `${Math.round(v)} px`, (v) => {
      state.iconSize = v;
    });
    grid.appendChild(el('div', { class: 'field' }, [el('label', { text: T('dock.iconSize') }), iconSlider.nodes[0]]));

    const spacingSlider = slider(state.spacing, 0, 48, 2, (v) => `${Math.round(v)} px`, (v) => {
      state.spacing = v;
    });
    grid.appendChild(el('div', { class: 'field' }, [el('label', { text: T('dock.spacing') }), spacingSlider.nodes[0]]));
  }

  if (kind !== 'dock') {
    const rowSlider = slider(state.rows, 1, 10, 1, (v) => String(Math.round(v)), (v) => {
      state.rows = v;
    });
    const colSlider = slider(state.columns, 1, 10, 1, (v) => String(Math.round(v)), (v) => {
      state.columns = v;
    });
    grid.appendChild(el('div', { class: 'field' }, [el('label', { text: T('common.rows') }), rowSlider.nodes[0]]));
    grid.appendChild(el('div', { class: 'field' }, [el('label', { text: T('common.columns') }), colSlider.nodes[0]]));
  }

  /* 显示器选择 */
  if (kind !== 'dock') {
    const dispOptions = [{ id: '', label: T('common.default') }].concat(
      (S.boot.displays || []).map((d) => ({
        id: String(d.id),
        label: `${d.index}. ${d.width}×${d.height}${d.primary ? ' ★' : ''}`
      }))
    );
    const dispSel = select(dispOptions, '', (v) => {
      state.displayId = v === '' ? null : Number(v);
    });
    grid.appendChild(el('div', { class: 'field' }, [el('label', { text: T('common.display') }), dispSel.nodes[0]]));
  }

  const createBtn = button(
    kind === 'organizer' ? T('org.create') : kind === 'station' ? T('station.create') : T('dock.create'),
    async () => {
      createBtn.disabled = true;
      const res = await window.tuck.items.create({ kind, ...state });
      createBtn.disabled = false;
      if (res && res.ok) {
        toast(kind === 'organizer' ? T('org.created', res.item.name) : T('org.created', res.item.name), 'ok');
        await reloadItems();
        renderNav();
        renderPage();
      } else {
        const reason = res && res.reason;
        const msg =
          reason === 'edgeOccupied'
            ? T('station.edgeOccupied')
            : reason === 'overlap'
              ? T('toast.nameDuplicate')
              : T('toast.failed', reason || '');
        toast(msg, 'err', 4200);
      }
    },
    'primary'
  );

  const body = [grid, el('div', { style: { marginTop: '16px' } }, [createBtn])];
  const title = kind === 'organizer' ? T('org.addTitle') : kind === 'station' ? T('station.addTitle') : T('dock.addTitle');
  return card(title, body);
}

/* ------------------------------------------------------------------ *
 * 9. 更新
 * ------------------------------------------------------------------ */

function buildUpdate() {
  const up = S.config.update;
  const frag = document.createDocumentFragment();
  frag.appendChild(head('update.title', 'update.subtitle'));

  const statusBadge = el('span', {
    class: 'badge' + (up.lastStatus === 'available' ? ' warn' : up.lastStatus === 'failed' ? ' err' : ' ok'),
    text:
      up.lastStatus === 'available'
        ? T('update.available')
        : up.lastStatus === 'failed'
          ? T('update.failed')
          : up.lastStatus === 'latest'
            ? T('update.upToDate')
            : T('update.ready')
  });

  const currentVersion = S.boot.version;
  const latestVersion = up.latestVersion || currentVersion;

  const hero = el('div', { class: 'update-hero' }, [
    el('div', {}, [
      el('div', { class: 'lbl', text: T('update.current') }),
      el('div', { class: 'big', text: currentVersion })
    ]),
    el('div', { class: 'arrow', text: '→' }),
    el('div', {}, [
      el('div', { class: 'lbl', text: T('update.latest') }),
      el('div', { class: 'big', text: latestVersion })
    ]),
    el('div', { style: { marginLeft: 'auto', textAlign: 'right' } }, [
      el('div', { class: 'lbl', text: T('update.edition') }),
      el('div', { style: { fontWeight: '600' }, text: S.boot.edition }),
      el('div', { class: 'lbl', style: { marginTop: '8px' }, text: T('update.lastCheck',
        up.lastCheck ? new Date(up.lastCheck).toLocaleString() : T('update.neverChecked')) })
    ])
  ]);

  const checkBtn = button(T('update.check'), async () => {
    checkBtn.disabled = true;
    checkBtn.textContent = T('update.checking');
    const res = await window.tuck.update.check();
    checkBtn.disabled = false;
    checkBtn.textContent = T('update.check');
    if (res) {
      S.config.update.latestVersion = res.latest;
      S.config.update.lastStatus = res.status;
      S.config.update.lastCheck = res.checkedAt;
      renderPage();
      toast(
        res.status === 'available'
          ? T('update.available') + ` ${res.latest}`
          : res.status === 'failed'
            ? T('update.error', res.error || '')
            : T('update.upToDate'),
        res.status === 'failed' ? 'err' : 'ok'
      );
    }
  }, 'primary');

  const feedInput = el('input', { type: 'text', value: up.feedUrl || '', placeholder: 'https://…' });
  feedInput.addEventListener('change', () => {
    patch('update', { feedUrl: feedInput.value.trim() });
  });

  const autoToggle = toggle(up.autoCheck, (v) => patch('update', { autoCheck: v }));

  frag.appendChild(card(null, [
    hero,
    el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', paddingTop: '12px', flexWrap: 'wrap' } }, [
      checkBtn,
      statusBadge
    ]),
    row(T('update.autoCheck'), T('update.autoCheckDesc'), autoToggle),
    el('div', { class: 'row stack' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title', text: T('update.feedUrl') }),
        el('div', { class: 'row-desc', text: T('update.feedUrlDesc') })
      ]),
      feedInput
    ])
  ]));

  /* 版本说明 */
  const releases = (S.boot.releases || []).slice();
  const notesNodes = releases.length
    ? releases.map((rel) =>
        el('div', { class: `release${rel.version === currentVersion ? ' current' : ''}` }, [
          el('div', { class: 'rh' }, [
            el('span', { class: 'ver', text: `v${rel.version}` }),
            rel.date ? el('span', { class: 'hint', text: rel.date }) : null,
            rel.channel ? el('span', { class: 'badge', text: rel.channel }) : null,
            rel.version === currentVersion ? el('span', { class: 'badge accent', text: T('update.current') }) : null
          ]),
          el('ul', {}, (rel.notes || []).map((n) => el('li', { text: n })))
        ])
      )
    : [el('div', { class: 'empty', text: T('update.noNotes') })];

  frag.appendChild(card(T('update.notes'), [el('div', { class: 'release-list', style: { padding: '8px 0' } }, notesNodes)]));

  const wrap = el('div');
  wrap.appendChild(frag);
  return wrap;
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

async function init() {
  S.boot = await window.tuck.bootstrap();
  setConfig(S.boot.config);
  S.strings = S.boot.strings;
  S.boot.releases = S.boot.releases || [];
  applySettingsAccent();

  /* 首次进入的板块：地址栏参数 > 上次停留 > 默认 */
  const wanted = new URLSearchParams(location.search).get('section');
  let initial = SECTION_IDS.includes(wanted) ? wanted : null;
  if (!initial) {
    try {
      const saved = localStorage.getItem('tuckdesk.section');
      if (SECTION_IDS.includes(saved)) initial = saved;
    } catch (_) {
      /* 存储不可用时忽略 */
    }
  }
  if (initial) S.section = initial;

  document.getElementById('tb-title').textContent = S.boot.name;
  document.getElementById('tb-version').textContent = `v${S.boot.version}`;
  document.title = S.boot.name;

  try {
    const logo = document.getElementById('tb-logo');
    logo.src = 'assets/icon-64.png';
  } catch (_) {
    /* 图标缺失时忽略 */
  }

  document.getElementById('btn-min').addEventListener('click', () => window.tuck.win.minimize());
  document.getElementById('btn-close').addEventListener('click', () => window.tuck.win.close());
  document.getElementById('btn-about').addEventListener('click', () => window.tuck.showAbout());

  renderNav();
  renderPage();

  window.tuck.settings.onChange((payload) => {
    if (payload && payload.config) {
      const prevLang = S.config && S.config.system.language;
      setConfig(payload.config);
      if (payload.strings) S.strings = payload.strings;
      if (prevLang !== payload.config.system.language) {
        renderNav();
        renderPage();
      }
    }
  });

  window.tuck.items.onChange((payload) => {
    if (payload && payload.items) {
      S.items = payload.items;
      S.config.items = payload.items;
      renderNav();
      const scroll = document.getElementById('content').scrollTop;
      renderPage();
      document.getElementById('content').scrollTop = scroll;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') location.reload();
  });
}

/** 把「设置界面」主题色应用到强调色上，让主题设置立刻可见 */
function applySettingsAccent() {
  const entry = S.config && S.config.theme && S.config.theme.settings;
  if (!entry) return;
  const root = document.documentElement;
  root.style.setProperty('--accent', entry.color);
  root.style.setProperty('--accent-soft', rgba(entry.color, 0.14));
}

init().catch((err) => {
  document.getElementById('page').textContent = `初始化失败：${err && err.message}`;
});
