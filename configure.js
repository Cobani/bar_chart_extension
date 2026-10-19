'use strict';

/**
 * Format dialog for the Bar Chart extension ("Format Extension" on the Marks
 * card, or the chart's right-click menu).
 *
 * Every change is saved straight away (debounced), so the chart behind the
 * modeless dialog updates live. Cancel restores what was stored on open.
 * The chart passes its series, members, lines and breakdown fields as the
 * dialog payload, because a dialog can't read the worksheet.
 *
 * The Icon and Title & text tabs are KPI Card's; the Card tab is Waterfall's
 * (without the divider).
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var activeTab = 'type';
  var shapeIndex = null;
  var info = { series: [], members: [], lines: [], dims: [], combos: [], measures: [], extras: [], levels: [], L: 1, bars: [], hasTarget: false, catCount: 0, axisType: 'dimension', focus: null };
  var selectedLine = null;

  var WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']];
  var LINE_STYLES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];

  var TABS = [
    { id: 'icon', label: 'Icon', build: buildIconTab, keys: ['icon'] },
    { id: 'text', label: 'Title & text', build: buildTextTab, keys: ['title', 'explanation'] },
    { id: 'type', label: 'Chart type', build: buildTypeTab, keys: ['chart', 'progress', 'lollipop', 'diverging'] },
    { id: 'bars', label: 'Bars', build: buildBarsTab, keys: ['spacing', 'shape', 'fill', 'border', 'shadow', 'hover'] },
    { id: 'colors', label: 'Colors', build: buildColorsTab, keys: ['colors', 'series'] },
    { id: 'labels', label: 'Labels', build: buildLabelsTab, keys: ['labels'] },
    { id: 'axes', label: 'Axes', build: buildAxesTab, keys: ['axisV', 'brk', 'axisC.show', 'axisC.position', 'axisC.placement', 'axisC.orientation', 'axisC.maxLines', 'axisC.maxWidth', 'axisC.align', 'axisC.title', 'axisC.font', 'axisC.size', 'axisC.weight', 'axisC.color', 'axisC.colorByBar', 'axisC.pillRadius', 'axisC.showLine', 'axisC.lineColor', 'axisC.lineWidth', 'axisC.dateFormat', 'axisC.hideLabelsAuto'] },
    { id: 'sort', label: 'Sort & Top N', build: buildSortTab, keys: ['topN', 'axisC.sort', 'axisC.sortBy', 'interaction.hidden', 'numbers.nullAs'] },
    { id: 'lines', label: 'Lines & targets', build: buildLinesTab, keys: ['lines', 'refs', 'target'] },
    { id: 'line', label: 'Line Chart', build: buildLineTab, keys: ['lineDefaults', 'lineSeries', 'lineAxis'] },
    { id: 'legend', label: 'Legend', build: buildLegendTab, keys: ['legend'] },
    { id: 'icons', label: 'Member icons', build: buildIconsTab, keys: ['icons'] },
    { id: 'groups', label: 'Groups', build: buildGroupsTab, keys: ['groups'] },
    { id: 'breakdown', label: 'Breakdown & drill', build: buildBreakdownTab, keys: ['breakdown', 'drill'] },
    { id: 'tooltip', label: 'Tooltip & actions', build: buildTooltipTab, keys: ['tooltip', 'interaction.rightClickMenu', 'interaction.dblclick', 'interaction.selectInTableau'] },
    { id: 'comments', label: 'Comments', build: buildCommentsTab, keys: ['comments.show', 'comments.display', 'comments.marker', 'comments.color', 'comments.size', 'comments.maxWidth', 'comments.author'] },
    { id: 'numbers', label: 'Numbers', build: buildNumbersTab, keys: ['numbers.mode', 'numbers.font', 'format'] },
    { id: 'card', label: 'Card', build: buildCardTab, keys: ['card'] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try {
        var p = JSON.parse(payload || '{}');
        Object.keys(info).forEach(function (k) { if (p[k] != null) info[k] = p[k]; });
      } catch (e) { /* opened without payload */ }

      cfg = Bc.read();
      original = Bc.clone(cfg);

      if (!info.series.length) {
        info.series = Object.keys(cfg.series).map(function (k) { return { key: k, name: k }; });
      }
      if (info.focus && info.focus.tab) activeTab = info.focus.tab;
      if (info.lines.length) selectedLine = info.lines[0].key;

      buildTabs();
      document.getElementById('cancel').addEventListener('click', function () {
        cfg = original;
        flush().then(close);
      });
      document.getElementById('done').addEventListener('click', function () { flush().then(close); });
      document.getElementById('reset-tab').addEventListener('click', resetTab);
    }).catch(function (err) {
      console.error('Bar Chart dialog failed to initialize:', err);
    });
  }

  function buildTabs () {
    var nav = document.getElementById('tabs');
    var panels = document.getElementById('panels');
    var scroll = panels.scrollTop;
    nav.innerHTML = '';
    panels.innerHTML = '';

    TABS.forEach(function (tab) {
      var b = h('button', { className: 'tab', type: 'button', role: 'tab', textContent: tab.label });
      b.setAttribute('aria-selected', String(tab.id === activeTab));
      b.addEventListener('click', function () { activeTab = tab.id; panels.scrollTop = 0; buildTabs(); });
      nav.appendChild(b);

      var panel = h('section', { className: 'panel', role: 'tabpanel' });
      panel.hidden = tab.id !== activeTab;
      if (!panel.hidden) tab.build(panel);
      panels.appendChild(panel);
    });
    panels.scrollTop = scroll;
  }

  function rebuild () { buildTabs(); }

  function resetTab () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    tab.keys.forEach(function (k) {
      var path = k.split('.');
      var def = path.reduce(function (o, x) { return o == null ? undefined : o[x]; }, Bc.DEFAULTS);
      var last = path.pop();
      var tgt = path.reduce(function (o, x) { return o[x]; }, cfg);
      tgt[last] = Bc.clone(def);
    });
    changed();
    buildTabs();
  }

  // ---------------------------------------------------------------------------
  // Number format editor (KPI Card "Big number" options + Waterfall signs)
  // ---------------------------------------------------------------------------
  function fmtRows (g, base, opts) {
    opts = opts || {};
    var fmtRow = selectRow('Number format', P(base, 'scale'), [
      ['dynamic', 'Dynamic (K / M / B)'], ['K', 'Thousands (K)'], ['M', 'Millions (M)'],
      ['B', 'Billions (B)'], ['none', 'Full number'],
      ['percent', 'Percentage (%)'], ['percentDynamic', 'Percentage, dynamic (K / M / B %)'],
      ['workbook', 'Workbook format']
    ]);
    fmtRow.querySelector('select').addEventListener('change', rebuild);
    g.appendChild(fmtRow);
    var scale = get(P(base, 'scale'));
    if (scale === 'percent' || scale === 'percentDynamic') {
      g.appendChild(checkboxRow('Value is a 0–1 ratio', P(base, 'pctFromRatio')));
      g.appendChild(help('On: 0.4523 → 45.23%. Off: 45.23 → 45.23%.'));
    }
    if (scale === 'workbook') g.appendChild(help('Uses Tableau’s format when a bar is a single value; sums (stacks, groups, Others) fall back to Dynamic.'));
    g.appendChild(numberRow('Decimal places', P(base, 'decimals'), 0, 6, 1));
    g.appendChild(checkboxRow('Thousands separator', P(base, 'thousands')));
    g.appendChild(textRow('Unit', P(base, 'unit'), 'e.g. SAR, M, %'));
    g.appendChild(selectRow('Unit position', P(base, 'unitPosition'), [['suffix', 'After number'], ['prefix', 'Before number']]));
    g.appendChild(checkboxRow('Space before / after unit', P(base, 'unitSpace')));
    if (!opts.noSign) g.appendChild(checkboxRow('“+” on positive values', P(base, 'plusSign')));
    g.appendChild(selectRow('Negative numbers', P(base, 'negStyle'), [['minus', '−201.4'], ['hyphen', '-201.4'], ['paren', '(201.4)']]));
    var sample = h('div', { className: 'sample' });
    var upd = function () {
      var f = get(base);
      sample.textContent = 'Preview: ' + Bc.formatNumber(1284500, f, { signed: true }) + '   ' + Bc.formatNumber(262.1, f, { signed: true }) +
        '   ' + Bc.formatNumber(-45200, f, { signed: true }) + '   ' + Bc.formatNumber(0.4523, f, { signed: true });
    };
    upd();
    g.addEventListener('input', upd);
    g.addEventListener('change', upd);
    g.appendChild(sample);
  }

  /** Format controls for one part: own format when the scope is "each". */
  function labelFmt (g, base, opts) {
    if (cfg.numbers.mode === 'each') {
      fmtRows(g, base, opts);
    } else {
      var note = h('p', { className: 'note' });
      note.innerHTML = 'Uses the shared number format (<a href="#">Numbers tab</a>). Switch the scope there to <b>Each part its own</b> to format this on its own.';
      note.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); activeTab = 'numbers'; buildTabs(); });
      g.appendChild(note);
    }
  }

  // ---------------------------------------------------------------------------
  // Mini chart pictures (presets, layout choices)
  // ---------------------------------------------------------------------------
  function thumb (o) {
    var W = 120; var H = 56;
    var vert = o.orientation !== 'horizontal';
    var cols = o.colors || ['#2F4B7C', '#EB644C', '#0E7C66', '#F2A93B'];
    var vals = o.vals || [0.85, 0.55, 0.7, 0.4];
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg">';
    if (o.bg) s += '<rect width="' + W + '" height="' + H + '" rx="4" fill="' + o.bg + '"/>';
    var n = vals.length;
    var r = o.round || 0;
    for (var i = 0; i < n; i++) {
      var v = vals[i];
      var c = cols[i % cols.length];
      if (vert) {
        var slot = (W - 16) / n; var x = 8 + i * slot; var bw = slot * (o.width || 0.6); var bh = (H - 12) * v;
        x += (slot - bw) / 2;
        if (o.track) s += '<rect x="' + x + '" y="6" width="' + bw + '" height="' + (H - 12) + '" rx="' + r + '" fill="#E9ECF0"/>';
        if (o.layout === 'stacked') {
          var y0 = H - 6;
          [0.5, 0.3, 0.2].forEach(function (f, k) { var hh = bh * f; y0 -= hh; s += '<rect x="' + x + '" y="' + y0 + '" width="' + bw + '" height="' + hh + '" fill="' + cols[k] + '"/>'; });
        } else if (o.layout === 'grouped' || o.layout === 'overlap') {
          var sub = o.layout === 'overlap' ? bw / 1.5 : bw / 2;
          s += '<rect x="' + x + '" y="' + (H - 6 - bh) + '" width="' + sub + '" height="' + bh + '" rx="' + r + '" fill="' + cols[0] + '"/>';
          var h2 = bh * 0.7;
          s += '<rect x="' + (x + (o.layout === 'overlap' ? sub / 2 : sub)) + '" y="' + (H - 6 - h2) + '" width="' + sub + '" height="' + h2 + '" rx="' + r + '" fill="' + cols[1] + '"/>';
        } else if (o.style === 'lollipop') {
          var cx = x + bw / 2;
          s += '<rect x="' + (cx - 1) + '" y="' + (H - 6 - bh) + '" width="2" height="' + bh + '" fill="' + c + '"/><circle cx="' + cx + '" cy="' + (H - 6 - bh) + '" r="4.5" fill="' + (o.ring ? '#fff' : c) + '" stroke="' + c + '" stroke-width="2"/>';
        } else if (o.layout === 'diverging') {
          var mid = H / 2;
          s += '<rect x="' + x + '" y="' + (mid - bh / 2) + '" width="' + bw + '" height="' + (bh / 2) + '" rx="' + r + '" fill="' + cols[0] + '"/><rect x="' + x + '" y="' + mid + '" width="' + bw + '" height="' + (bh * 0.35) + '" rx="' + r + '" fill="' + cols[1] + '"/>';
        } else {
          s += '<rect x="' + x + '" y="' + (H - 6 - bh) + '" width="' + bw + '" height="' + bh + '" rx="' + r + '" fill="' + c + '"/>';
        }
      } else {
        var slotH = (H - 8) / n; var y = 4 + i * slotH; var bh2 = slotH * (o.width || 0.62); var bw2 = (W - 30) * v;
        y += (slotH - bh2) / 2;
        var x0 = o.layout === 'diverging' ? W / 2 : 22;
        if (o.labels) s += '<rect x="4" y="' + (y + bh2 / 2 - 1.5) + '" width="14" height="3" rx="1.5" fill="#B8C2D0"/>';
        if (o.icons) s += '<rect x="4" y="' + y + '" width="' + bh2 + '" height="' + bh2 + '" rx="2" fill="' + c + '"/>';
        if (o.track) s += '<rect x="' + x0 + '" y="' + y + '" width="' + (W - 30) + '" height="' + bh2 + '" rx="' + r + '" fill="#E9ECF0"/>';
        if (o.layout === 'stacked') {
          var xx = x0;
          [0.5, 0.3, 0.2].forEach(function (f, k) { var ww = (W - 30) * (o.full ? 1 : v) * f; s += '<rect x="' + xx + '" y="' + y + '" width="' + ww + '" height="' + bh2 + '" fill="' + cols[k] + '"/>'; xx += ww; });
        } else if (o.layout === 'diverging') {
          s += '<rect x="' + (x0 - bw2 / 2.4) + '" y="' + y + '" width="' + (bw2 / 2.4) + '" height="' + bh2 + '" fill="' + cols[0] + '"/><rect x="' + (x0 + 1) + '" y="' + y + '" width="' + (bw2 / 2.1) + '" height="' + bh2 + '" fill="' + cols[1] + '"/>';
        } else if (o.style === 'lollipop') {
          s += '<rect x="' + x0 + '" y="' + (y + bh2 / 2 - 1) + '" width="' + bw2 + '" height="2" fill="' + c + '"/><circle cx="' + (x0 + bw2) + '" cy="' + (y + bh2 / 2) + '" r="' + Math.min(4.5, bh2 / 1.4) + '" fill="' + c + '"/>';
        } else {
          s += '<rect x="' + x0 + '" y="' + y + '" width="' + bw2 + '" height="' + bh2 + '" rx="' + r + '" fill="' + c + '"/>';
          if (o.twoTone) s += '<rect x="' + x0 + '" y="' + (y + bh2 / 2) + '" width="' + bw2 + '" height="' + (bh2 / 2) + '" fill="#fff" fill-opacity="0.18"/>';
        }
      }
    }
    if (o.line) s += '<polyline points="14,30 40,40 66,18 92,26 112,12" fill="none" stroke="#17202B" stroke-width="1.6"/>';
    return s + '</svg>';
  }

  /** Visual choice buttons: [[value, label, thumb opts]]. */
  function choiceRow (label, path, options, after) {
    var wrap = h('div');
    if (label) wrap.appendChild(h('div', { className: 'grid-title', textContent: label }));
    var box = h('div', { className: 'choice' });
    options.forEach(function (o) {
      var b = h('button', { type: 'button' });
      b.innerHTML = thumb(o[2]) + '<span>' + escapeHtml(o[1]) + '</span>';
      b.setAttribute('aria-pressed', String(get(path) === o[0]));
      b.addEventListener('click', function () { set(path, o[0]); if (after) after(); else rebuild(); });
      box.appendChild(b);
    });
    wrap.appendChild(box);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Quick looks (presets modelled on the reference designs)
  // ---------------------------------------------------------------------------
  var PRESETS = [
    { id: 'columns', name: 'Bold columns', look: { colors: ['#D63E2F'], width: 0.55 },
      patch: { colors: { mode: 'single', single: '#D63E2F' }, labels: { size: 15, weight: 700, colorMode: 'bar' }, axisV: { show: false },
        lines: { valueGrid: { show: false }, zero: { show: true, color: '#000000', width: 3 } }, axisC: { size: 13, weight: 700, colorByBar: true, showLine: false }, shape: { radius: 0 }, spacing: { width: 56 } } },
    { id: 'valueShades', name: 'Shaded by value', look: { colors: ['#64B5F6', '#90CAF9', '#42A5F5', '#1E88E5'] },
      patch: { colors: { mode: 'value', lowColor: '#BBDEFB', highColor: '#1E88E5' }, labels: { size: 9, weight: 400, colorMode: 'custom', color: '#263244' }, shape: { radius: 0 }, lines: { catGrid: { show: true } }, spacing: { width: 60 } } },
    { id: 'gradientRows', name: 'Gradient rows', look: { orientation: 'horizontal', colors: ['#0FC2C0'], bg: '#F2F3F4', width: 0.75 },
      patch: { chart: { orientation: 'horizontal' }, colors: { mode: 'single', single: '#16D0B8' }, fill: { type: 'gradient', gradientTo: 'color', gradientColor: '#06B6E0' },
        shape: { radius: 0, corners: 'none' }, labels: { show: false }, card: { plotBg: '#F4F5F6', plotBgOpacity: 100 }, lines: { valueGrid: { show: true, color: '#FFFFFF', width: 2 } }, spacing: { width: 76 }, axisC: { sort: 'valDesc' } } },
    { id: 'stackedRows', name: 'Stacked rows', look: { orientation: 'horizontal', layout: 'stacked', colors: ['#7CC4FA', '#3A8DDE', '#F0812F'] },
      patch: { chart: { orientation: 'horizontal', layout: 'stacked' }, colors: { palette: 'office' }, labels: { show: false }, legend: { align: 'center' }, shape: { radius: 0 }, spacing: { width: 60 } } },
    { id: 'butterfly', name: 'Left-right comparison', look: { orientation: 'horizontal', layout: 'diverging', colors: ['#3A7FD5', '#FF85C0'] },
      patch: { chart: { orientation: 'horizontal', layout: 'diverging' }, diverging: { labels: 'center' }, colors: { palette: 'duo' }, labels: { show: false }, shape: { radius: 0 }, spacing: { width: 55 }, legend: { align: 'center' } } },
    { id: 'race', name: 'Ranking with icons', look: { orientation: 'horizontal', colors: ['#8BC34A', '#F2C14E', '#9C4F96'], width: 0.8 },
      patch: { legend: { show: false }, chart: { orientation: 'horizontal' }, colors: { mode: 'category', palette: 'tableau10' }, icons: { show: true, placement: 'end', bg: 'circle', bgMode: 'custom', bgColor: '#FFFFFF' },
        labels: { colorMode: 'custom', color: '#55606E', weight: 400, size: 10 }, axisV: { position: 'opposite' }, shape: { radius: 0 }, spacing: { width: 82 }, axisC: { sort: 'valDesc' } } },
    { id: 'ranked', name: 'Ranked list, axis on top', look: { orientation: 'horizontal', colors: ['#039BE5'], bg: '#FDF3EE', icons: true, width: 0.7 },
      patch: { chart: { orientation: 'horizontal' }, axisV: { position: 'opposite' }, icons: { show: true, placement: 'axis' }, labels: { show: false }, colors: { mode: 'single', single: '#039BE5' },
        shape: { radius: 0 }, spacing: { width: 78 }, card: { plotBg: '#FDF3EE', plotBgOpacity: 100 }, axisC: { sort: 'valDesc' } } },
    { id: 'namesInside', name: 'Names inside the bars', look: { orientation: 'horizontal', colors: ['#E3913B', '#E3913B', '#512A6E'], width: 0.72 },
      patch: { legend: { show: false }, chart: { orientation: 'horizontal' }, axisC: { placement: 'insideBase', size: 13, weight: 700, sort: 'valDesc' }, axisV: { show: false }, lines: { valueGrid: { show: false }, zero: { show: false } },
        labels: { size: 14, weight: 700, colorMode: 'bar' }, shape: { radius: 0 }, colors: { mode: 'category', palette: 'vivid' }, spacing: { width: 72 } } },
    { id: 'hundredRows', name: '100% rows, dark', look: { orientation: 'horizontal', layout: 'stacked', full: true, bg: '#3B3A47', colors: ['#E07B9B', '#D7C4BE', '#5F9BA8'] },
      patch: { chart: { orientation: 'horizontal', layout: 'stacked100' }, labels: { size: 10, colorMode: 'custom', color: '#FFFFFF', totals: false }, axisV: { show: false },
        lines: { valueGrid: { show: false }, zero: { show: false } }, card: { plotBg: '#3B3A47', plotBgOpacity: 100 }, axisC: { color: '#FFFFFF', weight: 700, showLine: false },
        legend: { align: 'center', color: '#55606E' }, colors: { palette: 'dusk' }, shape: { radius: 0 }, spacing: { width: 70 } } },
    { id: 'roundedOverlap', name: 'Rounded, overlapping', look: { layout: 'overlap', bg: '#24195E', round: 6, colors: ['#F27A6B', '#8B5CF6'] },
      patch: { chart: { layout: 'overlap', overlapOffset: 55 }, shape: { endShape: 'pill' }, fill: { type: 'gradient', gradientStrength: 35 }, colors: { palette: 'vivid' }, labels: { show: false },
        axisV: { show: false }, lines: { valueGrid: { show: false }, zero: { show: false } }, legend: { position: 'bottom', color: '#B9B3F2' }, card: { plotBg: '#24195E', plotBgOpacity: 100 },
        axisC: { color: '#8C83F2', size: 14, showLine: false }, spacing: { width: 70 } } },
    { id: 'tubes', name: 'Filling tubes', look: { track: true, round: 9, colors: ['#E8574F', '#6A4C93', '#8A1C3A', '#E0A030'], width: 0.66 },
      patch: { legend: { show: false }, chart: { style: 'progress' }, shape: { endShape: 'pill', corners: 'all' }, spacing: { width: 66 }, colors: { mode: 'category', palette: 'vivid' },
        progress: { trackShadow: true, trackColor: '#E6E3E8' }, labels: { show: false }, axisC: { placement: 'pill', showLine: false }, axisV: { show: false }, lines: { valueGrid: { show: false }, zero: { show: false } } } },
    { id: 'rings', name: 'Lollipops with rings', look: { style: 'lollipop', ring: true, colors: ['#3BA7C4', '#B5C35A', '#F2A93B', '#E4572E'] },
      patch: { legend: { show: false }, chart: { style: 'lollipop' }, lollipop: { stemWidth: 16, head: 'ring', headSize: 30, ringWidth: 7 }, colors: { mode: 'category', palette: 'vivid' },
        axisC: { colorByBar: true, size: 16, weight: 700 }, labels: { show: false }, lines: { catGrid: { show: true } } } },
    { id: 'hexBadges', name: 'Hexagon value badges', look: { width: 0.2, colors: ['#F2A93B', '#6A4C93', '#1565C0', '#9C27B0'] },
      patch: { legend: { show: false }, spacing: { width: 22 }, labels: { badge: 'hexagon', badgeFill: 'white', badgeBorder: true, colorMode: 'auto', size: 10 }, colors: { mode: 'category', palette: 'vivid' },
        axisC: { placement: 'pill', pillRadius: 2 }, shape: { radius: 0 }, axisV: { show: false } } },
    { id: 'iconPills', name: 'Icons + two-tone bars', look: { orientation: 'horizontal', twoTone: true, icons: true, colors: ['#6DAA3E', '#F7B500', '#F28E1C', '#E8521F'], round: 3 },
      patch: { legend: { show: false }, chart: { orientation: 'horizontal' }, fill: { type: 'twoTone', twoTone: 16 }, icons: { show: true, placement: 'axis', bg: 'rounded', bgMode: 'bar', accent: true, fallback: 'fg-bar-chart-solid' },
        axisC: { show: false }, labels: { position: 'insideEnd', size: 13 }, colors: { mode: 'category', palette: 'vivid' }, shape: { radius: 4 }, spacing: { width: 60 } } },
    { id: 'valuePills', name: 'Value pills', look: { orientation: 'horizontal', round: 6, colors: ['#8B5CF6', '#6E8BFF', '#4FB0FF', '#3EE6F5'], labels: true },
      patch: { legend: { show: false }, chart: { orientation: 'horizontal' }, shape: { endShape: 'pill' }, colors: { mode: 'category', palette: 'cool' }, labels: { position: 'insideBase', colorMode: 'custom', color: '#FFFFFF', weight: 400 },
        axisV: { show: false }, lines: { valueGrid: { show: false }, zero: { show: false } }, axisC: { color: '#8C96A3', weight: 400, showLine: false }, spacing: { width: 70 } } },
    { id: 'grouped', name: 'Grouped, soft gradient', look: { layout: 'grouped', colors: ['#6B9E87', '#EF7B5A'] },
      patch: { fill: { type: 'gradient', gradientDir: 'across', gradientStrength: 30 }, legend: { position: 'bottom', marker: 'circle' }, colors: { palette: 'house' }, shape: { radius: 0 }, labels: { show: false } } },
    { id: 'median', name: 'Highlight + median line', look: { orientation: 'horizontal', colors: ['#B7C3D3', '#62C6D9', '#62C6D9', '#62C6D9'], labels: true },
      patch: { chart: { orientation: 'horizontal' }, colors: { mode: 'highlight', highlightColor: '#B7C3D3', mutedColor: '#62C6D9' }, refs: [{ type: 'median', label: 'Median', labelPos: 'start', color: '#9AA3AF' }],
        labels: { colorMode: 'custom', color: '#333F4F', size: 10, weight: 700 }, axisV: { show: false }, lines: { valueGrid: { show: false }, zero: { show: false } },
        axisC: { weight: 700, size: 10, showLine: false }, shape: { radius: 0 }, spacing: { width: 72 } } },
    { id: 'tableBars', name: 'Table with bars', look: { orientation: 'horizontal', colors: ['#F9C89B', '#F5A3A3', '#BFD8D8'], width: 1 },
      patch: { legend: { show: false }, chart: { orientation: 'horizontal' }, fill: { opacity: 45 }, axisC: { placement: 'insideBase', size: 14, weight: 700, showLine: false }, labels: { position: 'column', size: 14, weight: 700, colorMode: 'custom', color: '#17202B' },
        shape: { corners: 'none' }, spacing: { width: 100 }, lines: { catGrid: { show: true, color: '#D5D9DF' }, valueGrid: { show: false }, zero: { show: false } }, axisV: { show: false }, colors: { mode: 'category', palette: 'warm' }, border: { show: false } } },
    { id: 'combo', name: 'Bars + line, diamond labels', look: { line: true, colors: ['#7E57C2', '#F59E0B', '#1E5AA8', '#14A38B'] },
      patch: { legend: { show: false }, labels: { badge: 'diamond', badgeFill: 'bar', size: 10 }, fill: { type: 'gradient', gradientDir: 'across', gradientStrength: 40 }, colors: { mode: 'category', palette: 'vivid' },
        lineDefaults: { color: '#C62828', marker: 'circle' }, axisV: { show: false }, lines: { valueGrid: { show: false } } } },
    { id: 'tags', name: 'Slim bars, tags on top', look: { width: 0.18, round: 3, colors: ['#3BA7C4', '#2ECC71', '#8BC34A', '#F4D03F'] },
      patch: { legend: { show: false }, spacing: { widthMode: 'px', px: 9 }, shape: { endShape: 'pill', corners: 'all' }, colors: { mode: 'category', palette: 'vivid' }, labels: { position: 'column', badge: 'pill', badgeFill: 'bar', size: 9 },
        axisC: { placement: 'pill', showLine: false }, axisV: { show: false }, lines: { valueGrid: { show: true, style: 'dashed' }, zero: { show: false } } } },
    { id: 'outline', name: 'Outlined pills, ring labels', look: { round: 8, width: 0.3, colors: ['#9C6ADE', '#5DADE2', '#48C9B0', '#F0A04B'] },
      patch: { legend: { show: false }, spacing: { width: 26 }, shape: { endShape: 'pill', corners: 'all' }, fill: { opacity: 8 }, border: { show: true, width: 5, colorMode: 'bar' }, labels: { badge: 'ring', size: 14, offset: 8 },
        colors: { mode: 'category', palette: 'vivid' }, axisV: { show: false }, lines: { valueGrid: { show: false }, zero: { show: false } }, axisC: { colorByBar: true, showLine: false } } },
    { id: 'progressRows', name: 'Progress rows', look: { orientation: 'horizontal', track: true, round: 6, colors: ['#2F4B7C', '#EB644C', '#0E7C66', '#6B4FB0'] },
      patch: { chart: { orientation: 'horizontal', style: 'progress' }, shape: { endShape: 'pill', corners: 'all' }, labels: { position: 'insideEnd' }, progress: { showRemaining: false }, axisV: { show: false }, lines: { valueGrid: { show: false }, zero: { show: false } }, spacing: { width: 58 } } }
  ];

  var PRESET_RESETS = ['chart', 'progress', 'lollipop', 'diverging', 'spacing', 'shape', 'fill', 'border', 'shadow', 'hover', 'colors', 'labels', 'axisV', 'axisC', 'brk', 'lines', 'legend', 'icons', 'target', 'refs'];

  function deepAssign (target, patch) {
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) deepAssign(target[k], v);
      else target[k] = Bc.clone(v);
    });
  }

  function applyPreset (p) {
    var keep = {
      members: cfg.icons.members, custom: cfg.colors.custom, highlight: cfg.colors.highlight,
      sort: cfg.axisC.sort, sortBy: cfg.axisC.sortBy, dateFormat: cfg.axisC.dateFormat, axisType: cfg.chart.axisType,
      fallback: cfg.icons.fallback, vTitle: cfg.axisV.title, vFmt: cfg.axisV.fmt
    };
    PRESET_RESETS.forEach(function (k) { cfg[k] = Bc.clone(Bc.DEFAULTS[k]); });
    cfg.card.plotBg = Bc.DEFAULTS.card.plotBg;
    cfg.card.plotBgOpacity = Bc.DEFAULTS.card.plotBgOpacity;
    cfg.icons.members = keep.members;
    cfg.icons.fallback = keep.fallback;
    cfg.colors.custom = keep.custom;
    cfg.colors.highlight = keep.highlight;
    cfg.axisC.sort = keep.sort;
    cfg.axisC.sortBy = keep.sortBy;
    cfg.axisC.dateFormat = keep.dateFormat;
    cfg.axisV.title = keep.vTitle;
    cfg.axisV.fmt = keep.vFmt;
    cfg.chart.axisType = keep.axisType;
    deepAssign(cfg, p.patch);
    changed();
    setStatus('Applied “' + p.name + '” — fine-tune it on the other tabs');
    rebuild();
  }

  // ---------------------------------------------------------------------------
  // Chart type tab
  // ---------------------------------------------------------------------------
  function buildTypeTab (p) {
    var C = cfg.chart;
    var g0 = group(p, 'Quick looks');
    g0.appendChild(help('One click sets a ready-made look modelled on common bar chart designs. Your data, colours per member, icons and sorting are kept; the rest of the look is replaced.'));
    var box = h('div', { className: 'presets' });
    PRESETS.forEach(function (pr) {
      var b = h('button', { type: 'button', className: 'preset', title: 'Apply “' + pr.name + '”' });
      b.innerHTML = thumb(pr.look) + '<span>' + escapeHtml(pr.name) + '</span>';
      b.addEventListener('click', function () { applyPreset(pr); });
      box.appendChild(b);
    });
    g0.appendChild(box);

    var g1 = group(p, 'Orientation');
    g1.appendChild(choiceRow('', 'chart.orientation', [
      ['vertical', 'Vertical (columns)', { colors: ['#2F4B7C'] }],
      ['horizontal', 'Horizontal (bars)', { orientation: 'horizontal', colors: ['#2F4B7C'] }]
    ]));

    var g2 = group(p, 'Layout');
    var two = info.measures.length >= 2;
    g2.appendChild(choiceRow('', 'chart.layout', [
      ['regular', 'Regular', { colors: ['#2F4B7C'] }],
      ['stacked', 'Stacked', { layout: 'stacked' }],
      ['stacked100', '100% stacked', { layout: 'stacked', vals: [1, 1, 1, 1] }],
      ['diverging', two ? 'Left-right / up-down' : 'Left-right (2 values)', { orientation: 'horizontal', layout: 'diverging' }],
      ['overlap', 'Overlapping', { layout: 'overlap', round: 3 }]
    ]));
    if (!two && C.layout !== 'regular') {
      g2.appendChild(h('p', { className: 'note', textContent: 'Stacked, 100%, left-right and overlapping need two or more measures on the Measure tile (one bar each per category). Until then the chart draws regular bars. To split bars by a dimension, put it on the Dimension tile below the bars’ field and use Colors → Dimensions, or Breakdown & drill → Split bars into segments.' }));
    }
    if (C.layout === 'regular' && two) g2.appendChild(help('Bars of the same category stand side by side (grouped). Their spacing is on the Bars tab.'));
    if (C.layout === 'diverging') {
      var gd = group(p, 'Left-right comparison');
      gd.appendChild(help(C.orientation === 'horizontal'
        ? 'The first value goes left, the second right — e.g. Cost vs Revenue, Males vs Females.'
        : 'The first value goes down, the second up.'));
      gd.appendChild(segRow('First value goes', 'diverging.firstSide', [['neg', C.orientation === 'horizontal' ? 'Left' : 'Down'], ['pos', C.orientation === 'horizontal' ? 'Right' : 'Up']]));
      gd.appendChild(segRow('Category labels', 'diverging.labels', [['axis', 'On the axis'], ['center', 'Between the two sides']]));
      gd.appendChild(checkboxRow('Same scale both sides', 'diverging.symmetric'));
    }
    if (C.layout === 'overlap') {
      var go = group(p, 'Overlapping bars');
      go.appendChild(rangeRow('Shift of each bar', 'chart.overlapOffset', 10, 100, 1, '%'));
      go.appendChild(help('How far each next bar moves to the side, as a share of a bar’s width. 100% = side by side.'));
    }

    if (C.layout === 'regular' || C.layout === 'diverging' || C.layout === 'overlap') {
      var g3 = group(p, 'Bar style');
      g3.appendChild(choiceRow('', 'chart.style', [
        ['bar', 'Bar', { colors: ['#2F4B7C'], round: 2 }],
        ['lollipop', 'Lollipop', { style: 'lollipop', colors: ['#2F4B7C'] }],
        ['progress', 'Filling / progress', { track: true, round: 4, colors: ['#2F4B7C'] }]
      ]));
      if (C.style === 'progress') {
        var PR = cfg.progress;
        var gp = group(p, 'Filling bar');
        gp.appendChild(selectRow('Fill up to', 'progress.max', [
          ['auto', 'Automatic (100% for ratios, else the largest bar)'], ['percent', '100% (values are percentages or 0–1 ratios)'],
          ['max', 'Largest value in the chart'], ['target', 'Target measure (each bar its own)'], ['fixed', 'A fixed value']
        ], null, rebuild));
        if (PR.max === 'fixed') gp.appendChild(numberRow('Value', 'progress.fixed', -1e15, 1e15, 'any'));
        if (PR.max === 'target' && !info.hasTarget) gp.appendChild(h('p', { className: 'note', textContent: 'Drop a measure on the Target tile; bars without a target fill up to the largest value.' }));
        gp.appendChild(colorRow('Empty part color', 'progress.trackColor'));
        gp.appendChild(rangeRow('Empty part opacity', 'progress.trackOpacity', 0, 100, 1, '%'));
        gp.appendChild(checkboxRow('Empty part border', 'progress.trackBorder', rebuild));
        if (PR.trackBorder) gp.appendChild(colorRow('Border color', 'progress.trackBorderColor'));
        gp.appendChild(checkboxRow('Tube shading', 'progress.trackShadow'));
        gp.appendChild(checkboxRow('Write what’s left', 'progress.showRemaining', rebuild));
        if (PR.showRemaining) gp.appendChild(colorRow('Text color', 'progress.remainingColor'));
      }
      if (C.style === 'lollipop') {
        var LP = cfg.lollipop;
        var gl = group(p, 'Lollipop');
        gl.appendChild(numberRow('Stem width (px)', 'lollipop.stemWidth', 1, 40, 1));
        gl.appendChild(rangeRow('Stem opacity', 'lollipop.stemOpacity', 0, 100, 1, '%'));
        gl.appendChild(selectRow('Head', 'lollipop.head', [['circle', 'Circle'], ['ring', 'Ring'], ['square', 'Square'], ['diamond', 'Diamond'], ['hexagon', 'Hexagon'], ['none', 'None']], null, rebuild));
        gl.appendChild(numberRow('Head size (px)', 'lollipop.headSize', 2, 80, 1));
        if (LP.head === 'ring') gl.appendChild(numberRow('Ring width (px)', 'lollipop.ringWidth', 1, 20, 0.5));
        gl.appendChild(segRow('Head fill', 'lollipop.headFill', [['bar', 'Bar colour'], ['white', 'White'], ['custom', 'Custom']], rebuild));
        if (LP.headFill === 'custom') gl.appendChild(colorRow('Head color', 'lollipop.headColor'));
        gl.appendChild(checkboxRow('Value inside the head', 'lollipop.valueInHead'));
        gl.appendChild(help('The head grows to fit the value. Label font and number format are on the Labels and Numbers tabs.'));
      }
    }

    var g4 = group(p, 'Axis (categories)');
    if ((info.levels || []).length > 1) {
      var lo = info.levels.map(function (l, i) {
        return [i + 1, info.levels.slice(0, i + 1).map(function (x) { return x.name; }).join(' › ')];
      });
      g4.appendChild(selectRow('Bars are', 'chart.barLevel', lo, null, rebuild));
      g4.appendChild(help('How many Dimension fields make the bars (outer ones group them). The fields after them are the breakdown: tooltip rows, segments and drill-down levels.'));
    }
    g4.appendChild(selectRow('Axis shows', 'chart.axisType', [
      ['auto', 'Automatic'], ['dimension', 'Dimension members'], ['date', 'Dates (sorted and labelled as dates)'], ['measureNames', 'Measure names (one bar per measure)']
    ], null, rebuild));
    g4.appendChild(help(C.axisType === 'measureNames'
      ? 'Each measure on the Measure tile is a bar. Dimension fields, if any, group them.'
      : C.axisType === 'date' ? 'Axis values are read as dates. Pick the date format and the order on the Axes and Sort tabs.'
        : 'Automatic: dates when the bars’ Dimension field is a date, measure names when the Dimension tile is empty.' + (info.axisType ? ' Now: ' + ({ date: 'dates', measureNames: 'measure names', dimension: 'dimension members' })[info.axisType] + '.' : '')));

    var g5 = group(p, 'Animation');
    g5.appendChild(checkboxRow('Grow bars when data changes', 'chart.animate', rebuild));
    if (C.animate) g5.appendChild(numberRow('Duration (ms)', 'chart.animMs', 0, 3000, 50));
  }

  // ---------------------------------------------------------------------------
  // Bars tab
  // ---------------------------------------------------------------------------
  function buildBarsTab (p) {
    var SP = cfg.spacing;
    var g1 = group(p, 'Width and spacing');
    g1.appendChild(segRow('Bar width', 'spacing.widthMode', [['pct', 'Share of the space'], ['px', 'Fixed (px)']], rebuild));
    if (SP.widthMode === 'pct') {
      g1.appendChild(rangeRow('Width', 'spacing.width', 5, 100, 1, '%'));
      g1.appendChild(help('100% leaves no gap between categories; 50% makes the gap as wide as the bar.'));
    } else {
      g1.appendChild(numberRow('Width (px)', 'spacing.px', 1, 200, 1));
    }
    g1.appendChild(numberRow('Gap inside a group (px)', 'spacing.seriesGap', -40, 60, 1));
    g1.appendChild(help('Space between bars of the same category (grouped bars). Negative values make them overlap.'));
    g1.appendChild(numberRow('Gap between groups (px)', 'spacing.groupGap', 0, 120, 1));
    g1.appendChild(help('Extra space where a group (outer Dimension field, drill-down parent or custom group) ends.'));

    var S = cfg.shape;
    var g2 = group(p, 'Shape');
    g2.appendChild(selectRow('Bar end', 'shape.endShape', [['rounded', 'Rounded corners'], ['pill', 'Fully round (pill)'], ['flat', 'Square'], ['arrow', 'Arrow / chevron']], null, rebuild));
    if (S.endShape === 'rounded') g2.appendChild(numberRow('Corner radius (px)', 'shape.radius', 0, 60, 1));
    if (S.endShape === 'arrow') g2.appendChild(numberRow('Arrow depth (px)', 'shape.arrowDepth', 2, 60, 1));
    g2.appendChild(segRow('Round', 'shape.corners', [['end', 'Value end only'], ['all', 'Both ends'], ['none', 'No corners']]));

    var F = cfg.fill;
    var g3 = group(p, 'Fill');
    g3.appendChild(segRow('Fill', 'fill.type', [['solid', 'Solid'], ['gradient', 'Gradient'], ['twoTone', 'Two-tone']], rebuild));
    if (F.type === 'gradient') {
      g3.appendChild(segRow('Direction', 'fill.gradientDir', [['along', 'Along the bar'], ['across', 'Across the bar']]));
      g3.appendChild(segRow('Fades to', 'fill.gradientTo', [['tint', 'Lighter shade'], ['color', 'Another colour']], rebuild));
      if (F.gradientTo === 'tint') g3.appendChild(rangeRow('Strength', 'fill.gradientStrength', 0, 100, 1, '%'));
      else g3.appendChild(colorRow('Start color', 'fill.gradientColor'));
    }
    if (F.type === 'twoTone') g3.appendChild(rangeRow('Lighter half', 'fill.twoTone', 0, 60, 1, '%'));
    g3.appendChild(rangeRow('Opacity', 'fill.opacity', 0, 100, 1, '%'));
    g3.appendChild(help('Lower opacity makes the bars transparent (e.g. light table-style bars).'));

    var B = cfg.border;
    var g4 = group(p, 'Border');
    g4.appendChild(checkboxRow('Show border', 'border.show', rebuild));
    if (B.show) {
      g4.appendChild(numberRow('Width (px)', 'border.width', 0.5, 12, 0.5));
      g4.appendChild(segRow('Color', 'border.colorMode', [['darker', 'Darker bar colour'], ['bar', 'Bar colour'], ['custom', 'Custom']], rebuild));
      if (B.colorMode === 'custom') g4.appendChild(colorRow('Border color', 'border.color'));
      g4.appendChild(rangeRow('Opacity', 'border.opacity', 0, 100, 1, '%'));
      g4.appendChild(segRow('Style', 'border.style', LINE_STYLES));
    }

    var SH = cfg.shadow;
    var g5 = group(p, 'Shadow');
    g5.appendChild(checkboxRow('Drop shadow', 'shadow.show', rebuild));
    if (SH.show) {
      g5.appendChild(colorRow('Color', 'shadow.color'));
      g5.appendChild(rangeRow('Opacity', 'shadow.opacity', 0, 100, 1, '%'));
      g5.appendChild(numberRow('Blur (px)', 'shadow.blur', 0, 40, 1));
      g5.appendChild(numberRow('Offset x (px)', 'shadow.dx', -20, 20, 1));
      g5.appendChild(numberRow('Offset y (px)', 'shadow.dy', -20, 20, 1));
    }

    var g6 = group(p, 'Hover');
    g6.appendChild(checkboxRow('Fade other bars', 'hover.dimOthers', rebuild));
    if (cfg.hover.dimOthers) g6.appendChild(rangeRow('Faded opacity', 'hover.dimOpacity', 5, 100, 1, '%'));
  }

  // ---------------------------------------------------------------------------
  // Colors tab
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Members: what "each bar" is — the bar's own name, a measure name, or the
  // value of one Dimension field. Used by Colors, Highlight, Groups and Icons.
  // ---------------------------------------------------------------------------
  function sourceOptions (withAuto) {
    var o = [];
    if (withAuto) o.push(['auto', 'The bar’s own name']);
    o.push(['measures', 'Measure names (Measure tile)']);
    (info.levels || []).forEach(function (l, i) { o.push(['dim:' + i, l.name + ' (Dimension field ' + (i + 1) + ')']); });
    return o;
  }

  function sourceValues (src) {
    if (src === 'measures') return info.measures.map(function (m) { return m.name; });
    if (src && src.indexOf('dim:') === 0) {
      var l = (info.levels || [])[Number(src.slice(4))];
      return l ? l.values : [];
    }
    return info.members;
  }

  function sourceRow (label, path, withAuto, after) {
    var opts = sourceOptions(withAuto);
    var cur = get(path);
    if (!opts.some(function (o) { return o[0] === cur; })) set(path, opts[0][0]);
    return selectRow(label, path, opts, null, after || rebuild);
  }

  // ---------------------------------------------------------------------------
  // Palettes (swatches are editable: double-click one)
  // ---------------------------------------------------------------------------
  function pal () { return Bc.paletteColors(cfg.colors.palette, cfg.colors.paletteEdits); }

  function paletteSelect (path) {
    var r = row('Palette');
    var wrap = h('div', { className: 'inline' });
    var sel = h('select');
    sel.style.width = 'auto';
    Object.keys(Bc.PALETTES).forEach(function (k) { sel.appendChild(h('option', { value: k, textContent: Bc.PALETTES[k].label })); });
    sel.value = get(path);
    var sw = h('span', { className: 'swatches' });
    var paint = function () {
      sw.innerHTML = '';
      Bc.paletteColors(sel.value, cfg.colors.paletteEdits).forEach(function (c, i) {
        var s = h('span', { title: 'Double-click to change this colour' });
        s.style.background = c;
        s.style.cursor = 'pointer';
        var inp = h('input', { type: 'color', value: c });
        inp.style.cssText = 'position:absolute;opacity:0;width:0;height:0;pointer-events:none';
        s.style.position = 'relative';
        s.appendChild(inp);
        s.addEventListener('dblclick', function () { inp.click(); });
        inp.addEventListener('input', function () {
          var E = cfg.colors.paletteEdits;
          var arr = (E[sel.value] = Array.isArray(E[sel.value]) ? E[sel.value] : []);
          arr[i] = inp.value.toUpperCase();
          s.style.background = inp.value;
          changed();
        });
        inp.addEventListener('change', rebuild);
        sw.appendChild(s);
      });
    };
    paint();
    sel.addEventListener('change', function () { set(path, sel.value); rebuild(); });
    wrap.append(sel, sw);
    r.appendChild(wrap);
    var frag = h('div');
    frag.appendChild(r);
    var E = cfg.colors.paletteEdits;
    if (Array.isArray(E[sel.value]) && E[sel.value].some(Boolean)) {
      var reset = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Undo palette edits' });
      reset.addEventListener('click', function () { delete cfg.colors.paletteEdits[sel.value]; changed(); rebuild(); });
      frag.appendChild(h('div', { className: 'inline' }, [h('span', { className: 'help', textContent: 'Double-click a swatch to change it.' }), reset]));
    } else {
      frag.appendChild(help('Double-click a swatch to change that palette colour.'));
    }
    return frag;
  }

  function normalizeColorMode () {
    var C = cfg.colors;
    if (C.mode === 'series') C.mode = 'measures';
    if (C.mode === 'category') C.mode = 'dimensions';
    if (C.mode === 'auto') C.mode = info.measures.length > 1 ? 'measures' : 'single';
    if (C.mode === 'dimensions' && !(info.levels || []).length) C.mode = 'measures';
  }

  function levelSelect (label, path, withAuto) {
    var L = info.L || 1;
    var opts = withAuto ? [['auto', 'The bars’ field' + (info.levels[L - 1] ? ' (' + info.levels[L - 1].name + ')' : '')]] : [];
    info.levels.forEach(function (l, i) { opts.push([String(i), l.name + (i < L ? '' : ' (splits the bars)')]); });
    return selectRow(label, path, opts, null, rebuild);
  }

  function dimLevel () {
    var lv = cfg.colors.dimLevel;
    var L = info.L || 1;
    if (lv === 'auto' || lv === '' || lv == null) return L - 1;
    return Math.max(0, Math.min(info.levels.length - 1, Number(lv) || 0));
  }

  function buildColorsTab (p) {
    normalizeColorMode();
    var C = cfg.colors;
    var focus = info.focus || {};
    var g1 = group(p, 'Colour bars by');
    var modes = [['single', 'One colour'], ['measures', 'Measures'], ['dimensions', 'Dimensions'], ['value', 'Gradient by value'], ['sign', 'Positive / negative'], ['highlight', 'Highlight some bars']];
    if (!(info.levels || []).length) modes = modes.filter(function (m) { return m[0] !== 'dimensions'; });
    g1.appendChild(selectRow('Colour by', 'colors.mode', modes, null, rebuild));
    var mode = C.mode;

    if (mode === 'single') {
      g1.appendChild(colorRow('Bar color', 'colors.single'));
    }

    if (mode === 'measures') {
      g1.appendChild(paletteSelect('colors.palette'));
      var gm = group(p, 'Measures');
      gm.appendChild(help('Each measure on the Measure tile: its name in the legend and tooltip, and its colour (empty = palette).'));
      var pm = pal();
      info.measures.forEach(function (m, i) {
        var box = h('div', { className: 'subcard' });
        if (focus.item === m.key || focus.member === m.name) { box.style.outline = '2px solid var(--accent)'; setTimeout(function () { box.scrollIntoView({ block: 'center' }); }, 0); }
        box.appendChild(textRow('Name', ['series', m.key, 'label'], m.name));
        box.appendChild(optColorRow('Color', ['series', m.key, 'color'], pm[i % pm.length]));
        gm.appendChild(box);
      });
    }

    if (mode === 'dimensions') {
      if (info.levels.length > 1) {
        g1.appendChild(levelSelect('Colour by field', 'colors.dimLevel', true));
        g1.appendChild(help('A field the bars are made of colours the bars; a deeper field splits each bar into coloured segments (e.g. Region within each Sub-Category).'));
      }
      g1.appendChild(paletteSelect('colors.palette'));
      var k = dimLevel();
      var lv = info.levels[k];
      var gd = group(p, (lv ? lv.name : 'Dimension') + ' colours');
      gd.appendChild(help('Each value gets the next palette colour. Pick one to change it; Reset goes back to the palette.'));
      var pd = pal();
      var lst = h('div', { className: 'memberlist' });
      (lv ? lv.values : []).forEach(function (m, i) {
        var r = optColorRow(m, ['colors', 'custom', k + '|' + m], pd[i % pd.length]);
        if (focus.member === m) { r.style.outline = '2px solid var(--accent)'; setTimeout(function () { r.scrollIntoView({ block: 'center' }); }, 0); }
        lst.appendChild(r);
      });
      gd.appendChild(lst);
    }

    if (mode === 'value') {
      g1.appendChild(selectRow('Value from', 'colors.valueField', [['__self', 'Each bar’s own value']].concat(info.measures.map(function (m) { return [m.key, m.name]; })), null, rebuild));
      g1.appendChild(help('Bars are shaded from the lowest to the highest value of this measure, e.g. colour Sales bars by Profit.'));
      g1.appendChild(colorRow('Lowest value', 'colors.lowColor'));
      g1.appendChild(colorRow('Highest value', 'colors.highColor'));
    }

    if (mode === 'sign') {
      g1.appendChild(colorRow('Positive', 'colors.posColor'));
      g1.appendChild(colorRow('Negative', 'colors.negColor'));
    }

    if (mode === 'highlight') {
      g1.appendChild(colorRow('Highlighted', 'colors.highlightColor'));
      g1.appendChild(colorRow('Other bars', 'colors.mutedColor'));
      g1.appendChild(numberRow('Highlight top N', 'colors.highlightTop', 0, 100, 1));
      g1.appendChild(help('0 = off. Or tick values below, or right-click a bar → Highlight.'));
      var gh = group(p, 'Highlighted bars');
      gh.appendChild(sourceRow('Pick from', 'colors.highlightBy', true, function () { set('colors.highlight', []); rebuild(); }));
      var src = C.highlightBy;
      if (src && src.indexOf('dim:') === 0 && Number(src.slice(4)) >= (info.L || 1)) gh.appendChild(help('This field is deeper than the bars, so its values highlight segments of each bar.'));
      var list = h('div', { className: 'memberlist' });
      var vals = sourceValues(src);
      if (!vals.length) list.appendChild(h('p', { className: 'note', textContent: 'No values yet.' }));
      vals.forEach(function (m) {
        var it = h('label', { className: 'member' });
        var cb = h('input', { type: 'checkbox' });
        cb.checked = C.highlight.indexOf(m) >= 0;
        cb.addEventListener('change', function () {
          var a = C.highlight.filter(function (x) { return x !== m; });
          if (cb.checked) a.push(m);
          set('colors.highlight', a);
        });
        it.append(cb, h('span', { className: 'mname', textContent: m }), h('span'));
        list.appendChild(it);
      });
      gh.appendChild(list);
    }

    var gr = group(p, 'Colour rules');
    gr.appendChild(help('Rules win over the colouring above: the first matching rule colours the bar (e.g. value < 0 → red).'));
    (C.rules || []).forEach(function (rule, i) {
      var r = h('div', { className: 'inline' });
      r.style.marginBottom = '6px';
      var op = h('select');
      op.style.width = '90px';
      ['>', '>=', '<', '<=', '='].forEach(function (o) { op.appendChild(h('option', { value: o, textContent: 'value ' + o })); });
      op.value = rule.op;
      op.addEventListener('change', function () { C.rules[i].op = op.value; changed(); });
      var val = h('input', { type: 'number', value: rule.value, step: 'any' });
      val.addEventListener('input', function () { if (val.value !== '') { C.rules[i].value = Number(val.value); changed(); } });
      var col = h('input', { type: 'color', value: Bc.normalizeHex(rule.color) || '#B4431E' });
      col.addEventListener('input', function () { C.rules[i].color = col.value.toUpperCase(); changed(); });
      var del = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Remove' });
      del.addEventListener('click', function () { C.rules.splice(i, 1); changed(); rebuild(); });
      r.append(op, val, col, del);
      gr.appendChild(r);
    });
    var add = h('button', { type: 'button', className: 'btn', textContent: 'Add rule' });
    add.addEventListener('click', function () { C.rules.push({ op: '<', value: 0, color: '#B4431E' }); changed(); rebuild(); });
    gr.appendChild(add);
  }

  /** Colour row with an empty state ("palette") and a Reset button. */
  function optColorRow (label, path, fallback) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var cur = get(path);
    var picker = h('input', { type: 'color', value: Bc.normalizeHex(cur) || Bc.normalizeHex(fallback) || '#000000' });
    var hex = h('input', { type: 'text', className: 'hex', value: cur || '', placeholder: fallback || 'palette', maxLength: 7, spellcheck: false });
    var reset = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Reset' });
    picker.addEventListener('input', function () { hex.value = picker.value.toUpperCase(); set(path, hex.value); });
    hex.addEventListener('input', function () {
      var v = Bc.normalizeHex(hex.value);
      hex.classList.toggle('is-invalid', !!hex.value && !v);
      if (v) { picker.value = v; set(path, v); }
    });
    reset.addEventListener('click', function () {
      var keys = P(path); var last = keys.pop();
      var o = keys.reduce(function (a, k) { return a && a[k]; }, cfg);
      if (o) delete o[last];
      if (keys[0] === 'series' && o) o[last] = '';
      hex.value = ''; picker.value = Bc.normalizeHex(fallback) || '#000000';
      changed();
    });
    wrap.append(picker, hex, reset);
    r.appendChild(wrap);
    return r;
  }

  // ---------------------------------------------------------------------------
  // Labels tab
  // ---------------------------------------------------------------------------
  function buildLabelsTab (p) {
    var LB = cfg.labels;
    var g1 = group(p, 'Value labels');
    g1.appendChild(checkboxRow('Show values', 'labels.show', rebuild));
    if (!LB.show) return;
    g1.appendChild(selectRow('Place', 'labels.position', [
      ['outsideEnd', 'Outside, at the end'], ['insideEnd', 'Inside, at the end'], ['center', 'Inside, middle'],
      ['insideBase', 'Inside, at the base'], ['column', 'In a column at the chart edge']
    ], null, rebuild));
    g1.appendChild(checkboxRow('Move outside if it doesn’t fit', 'labels.insideFallback'));
    g1.appendChild(selectRow('Show', 'labels.content', [
      ['value', 'Value'], ['pctTotal', '% of total'], ['pctCat', '% of the category (stacks)'], ['valuePct', 'Value and %'],
      ['diffPrev', 'Difference from previous bar'], ['pctDiffPrev', '% difference from previous bar'], ['rank', 'Rank (#1, #2 …)'], ['nameValue', 'Name: value']
    ]));
    g1.appendChild(selectRow('Which bars', 'labels.which', [['all', 'All bars'], ['minmax', 'Highest and lowest'], ['max', 'Highest only'], ['min', 'Lowest only'], ['first', 'First'], ['last', 'Last (most recent)']]));
    g1.appendChild(numberRow('Distance from bar (px)', 'labels.offset', 0, 40, 1));

    var g2 = group(p, 'When labels overlap');
    g2.appendChild(segRow('Overlapping labels', 'labels.overlap', [['hide', 'Hide smaller ones'], ['shrink', 'Shrink, then hide'], ['none', 'Show all']]));
    g2.appendChild(help('Bigger values win. Labels that would be cut off at the chart edge are hidden too.'));

    var g3 = group(p, 'Text');
    g3.appendChild(numberRow('Size (px)', 'labels.size', 6, 48, 1));
    g3.appendChild(selectRow('Weight', 'labels.weight', WEIGHTS));
    g3.appendChild(checkboxRow('Italic', 'labels.italic'));
    g3.appendChild(selectRow('Color', 'labels.colorMode', [['auto', 'Automatic (readable on / next to the bar)'], ['bar', 'Bar colour'], ['blend', 'Blend of the bar colour'], ['custom', 'Custom']], null, rebuild));
    if (LB.colorMode === 'blend') {
      g3.appendChild(rangeRow('Blend', 'labels.blend', -100, 100, 1, ''));
      g3.appendChild(help('Below 0 mixes the bar colour with black (darker), above 0 with white (lighter).'));
    }
    if (LB.colorMode === 'custom') g3.appendChild(colorRow('Text color', 'labels.color'));
    g3.appendChild(help('Font: Numbers tab → Chart text.'));

    var g4 = group(p, 'Badge behind the value');
    g4.appendChild(selectRow('Badge', 'labels.badge', [['none', 'None'], ['pill', 'Pill'], ['rounded', 'Rounded box'], ['tag', 'Tag (points at the bar)'], ['circle', 'Circle'], ['ring', 'Ring'], ['hexagon', 'Hexagon'], ['diamond', 'Diamond']], null, rebuild));
    if (LB.badge !== 'none') {
      if (LB.badge !== 'ring') {
        g4.appendChild(segRow('Badge fill', 'labels.badgeFill', [['bar', 'Bar colour'], ['white', 'White'], ['custom', 'Custom']], rebuild));
        if (LB.badgeFill === 'custom') g4.appendChild(colorRow('Badge color', 'labels.badgeColor'));
        g4.appendChild(checkboxRow('Badge outline', 'labels.badgeBorder'));
      }
    }

    var g5 = group(p, 'Stacked bars');
    g5.appendChild(checkboxRow('Label each segment', 'labels.segments'));
    g5.appendChild(checkboxRow('Total at the end of each stack', 'labels.totals', rebuild));
    if (LB.totals) {
      g5.appendChild(numberRow('Total size (px)', 'labels.totalSize', 6, 48, 1));
      g5.appendChild(selectRow('Total weight', 'labels.totalWeight', WEIGHTS));
      g5.appendChild(colorRow('Total color', 'labels.totalColor'));
    }

    var g6 = group(p, 'Number format');
    labelFmt(g6, 'labels.fmt');
    if (LB.totals) { var g7 = group(p, 'Stack total number format'); labelFmt(g7, 'labels.totalFmt'); }
  }

  // ---------------------------------------------------------------------------
  // Axes tab
  // ---------------------------------------------------------------------------
  function buildAxesTab (p) {
    var a = cfg.axisV;
    var vert = cfg.chart.orientation !== 'horizontal';
    var g1 = group(p, 'Value axis — range');
    g1.appendChild(segRow('Starts at', 'axisV.base', [['zero', 'Zero'], ['auto', 'Close to the data'], ['manual', 'Fixed value']], rebuild));
    if (a.base === 'auto') {
      g1.appendChild(rangeRow('Room below', 'axisV.padding', 0, 100, 1, '%'));
      g1.appendChild(help('Space under the smallest bar, as a share of the data range, then rounded to a tick. Bars cut short get the clipped-bar marker.'));
    } else if (a.base === 'manual') {
      g1.appendChild(numberRow('Minimum', 'axisV.manualMin', -1e15, 1e15, 'any'));
    }
    g1.appendChild(segRow('Ends at', 'axisV.maxMode', [['auto', 'Automatic'], ['manual', 'Fixed value']], rebuild));
    if (a.maxMode === 'manual') g1.appendChild(numberRow('Maximum', 'axisV.manualMax', -1e15, 1e15, 'any'));
    g1.appendChild(numberRow('Tick marks (about)', 'axisV.ticks', 2, 14, 1));
    g1.appendChild(checkboxRow('Reversed', 'axisV.reversed'));
    g1.appendChild(help('Progress bars and 100% stacks always start at zero.'));

    var B = cfg.brk;
    var gb = group(p, 'Clipped bar marker');
    gb.appendChild(checkboxRow('Show when the axis doesn’t start at zero', 'brk.show', rebuild));
    gb.appendChild(help('Bars are cut short when the axis starts above zero (or ends below a value). The marker shows that the bar is really longer.'));
    if (B.show) {
      gb.appendChild(selectRow('Style', 'brk.style', [['slash', 'Slanted lines'], ['zigzag', 'Zigzag'], ['gap', 'Plain gap']]));
      gb.appendChild(rangeRow('Position', 'brk.pos', 4, 90, 1, '%'));
      gb.appendChild(colorRow('Gap color', 'brk.bandColor'));
      gb.appendChild(help('Match the background behind the chart.'));
      gb.appendChild(colorRow('Line color', 'brk.lineColor'));
    }

    var g2 = group(p, 'Value axis — labels');
    g2.appendChild(checkboxRow('Show axis', 'axisV.show', rebuild));
    if (a.show) {
      g2.appendChild(segRow('Side', 'axisV.position', vert ? [['auto', 'Left'], ['opposite', 'Right']] : [['auto', 'Bottom'], ['opposite', 'Top']]));
      g2.appendChild(textRow('Axis title', 'axisV.title', 'e.g. SAR M'));
      fontRows(g2, 'axisV', false);
      g2.appendChild(checkboxRow('Axis line', 'axisV.showLine', rebuild));
      if (a.showLine) g2.appendChild(colorRow('Line color', 'axisV.lineColor'));
      var g3 = group(p, 'Value axis — number format');
      g3.appendChild(checkboxRow('Use shared format', 'axisV.useGlobalFormat', rebuild));
      if (!a.useGlobalFormat) fmtRows(g3, 'axisV.fmt', { noSign: true });
    }

    var x = cfg.axisC;
    var g4 = group(p, 'Category axis');
    g4.appendChild(checkboxRow('Show category names', 'axisC.show', rebuild));
    if (x.show) {
      g4.appendChild(selectRow('Names are', 'axisC.placement', [
        ['axis', 'On the axis'], ['pill', 'On the axis, in coloured pills'], ['insideBase', 'Inside the bar, at the base'],
        ['rotatedInside', 'Inside the bar, rotated (columns)'], ['above', 'Beyond the bar end']
      ], null, rebuild));
      if (x.placement === 'axis' || x.placement === 'pill') {
        g4.appendChild(segRow('Side', 'axisC.position', vert ? [['auto', 'Bottom'], ['opposite', 'Top']] : [['auto', 'Left'], ['opposite', 'Right']]));
        if (vert) {
          g4.appendChild(segRow('Direction', 'axisC.orientation', [['wrap', 'Horizontal'], ['angled', 'Angled'], ['vertical', 'Vertical']], rebuild));
        } else {
          g4.appendChild(numberRow('Column width (px)', 'axisC.maxWidth', 0, 600, 1));
          g4.appendChild(help('0 = automatic (up to about a third of the chart).'));
          g4.appendChild(segRow('Align', 'axisC.align', [['start', 'Left'], ['center', 'Center'], ['end', 'Next to the bar']]));
        }
        if (!vert || x.orientation === 'wrap') g4.appendChild(numberRow('Max lines', 'axisC.maxLines', 1, 5, 1));
        if (x.placement === 'pill') g4.appendChild(numberRow('Pill radius (px)', 'axisC.pillRadius', 0, 30, 1));
        g4.appendChild(checkboxRow('Skip names that would overlap', 'axisC.hideLabelsAuto'));
      }
      g4.appendChild(textRow('Axis title', 'axisC.title', ''));
      fontRows(g4, 'axisC', false);
      g4.appendChild(checkboxRow('Colour names like their bar', 'axisC.colorByBar'));
      if (info.axisType === 'date' || cfg.chart.axisType === 'date' || info.isDate) {
        g4.appendChild(selectRow('Date format', 'axisC.dateFormat', Bc.DATE_FORMATS));
      }
    }
    g4.appendChild(checkboxRow('Axis line', 'axisC.showLine', rebuild));
    if (x.showLine) {
      g4.appendChild(colorRow('Line color', 'axisC.lineColor'));
      g4.appendChild(numberRow('Line width', 'axisC.lineWidth', 0.5, 8, 0.5));
    }
  }

  // ---------------------------------------------------------------------------
  // Sort & Top N tab
  // ---------------------------------------------------------------------------
  function buildSortTab (p) {
    var g1 = group(p, 'Order of the bars');
    g1.appendChild(selectRow('Sort', 'axisC.sort', Bc.VALUE_SORTS, null, rebuild));
    if (/^val/.test(cfg.axisC.sort)) {
      g1.appendChild(selectRow('By', 'axisC.sortBy', [['__total', 'Total of all measures']].concat(info.measures.length > 1 ? info.measures.map(function (s) { return [s.key, s.name]; }) : [])));
    }
    g1.appendChild(help('With two or more Dimension fields on the axis, bars are sorted inside their outer group. Drill-down children follow the same order.'));

    var T = cfg.topN;
    var g2 = group(p, 'Top N');
    g2.appendChild(checkboxRow('Show only the top N', 'topN.enabled', rebuild));
    if (T.enabled) {
      g2.appendChild(numberRow('N', 'topN.n', 1, 500, 1));
      g2.appendChild(segRow('Keep', 'topN.direction', [['top', 'Largest'], ['bottom', 'Smallest']]));
      if ((info.levels || []).length) {
        var L = info.L || 1;
        var lvOpts = [['auto', 'The bars (' + (info.levels[L - 1] ? info.levels[L - 1].name : 'bars') + ')']].concat(info.levels.map(function (l, i) {
          return [String(i), l.name + (i < L ? '' : ' (breakdown)')];
        }));
        g2.appendChild(selectRow('Top N of', 'topN.level', lvOpts, null, rebuild));
        var k = cfg.topN.level === 'auto' ? L - 1 : Number(cfg.topN.level) || 0;
        g2.appendChild(help(k > 0 && info.levels[k - 1]
          ? 'Ranked inside each ' + info.levels[k - 1].name + ': e.g. the top ' + cfg.topN.n + ' ' + info.levels[k].name + ' values in every ' + info.levels[k - 1].name + '.'
          : 'Ranked across the whole chart.'));
      }
      g2.appendChild(selectRow('Ranked by', 'topN.by', [['__total', 'Total of all measures']].concat(info.measures.map(function (s) { return [s.key, s.name]; }))));
      g2.appendChild(help('The ranking measure can differ from what the bars show, e.g. top products by Sales while showing Sales and Profit.'));
      g2.appendChild(checkboxRow('Show the rest as one bar', 'topN.others', rebuild));
      if (T.others) {
        g2.appendChild(textRow('Label', 'topN.label', 'Others'));
        g2.appendChild(colorRow('Color', 'topN.color'));
        g2.appendChild(segRow('Value', 'topN.othersAgg', [['sum', 'Sum of the rest'], ['avg', 'Average of the rest']]));
        g2.appendChild(help('Use Average for averages, ratios and percentages.'));
        g2.appendChild(checkboxRow('Always last', 'topN.othersLast'));
      }
    }

    var hidden = cfg.interaction.hidden || [];
    var g3 = group(p, 'Hidden bars');
    if (!hidden.length) g3.appendChild(help('Nothing hidden. Right-click a bar → Hide or Keep only.'));
    hidden.forEach(function (m) {
      var r = row(m);
      var b = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Show' });
      b.addEventListener('click', function () { set('interaction.hidden', hidden.filter(function (x) { return x !== m; })); rebuild(); });
      r.appendChild(h('div', { className: 'inline' }, [b]));
      g3.appendChild(r);
    });
    if (hidden.length > 1) {
      var all = h('button', { type: 'button', className: 'btn', textContent: 'Show all' });
      all.addEventListener('click', function () { set('interaction.hidden', []); rebuild(); });
      g3.appendChild(all);
    }

    var g4 = group(p, 'Empty values');
    g4.appendChild(segRow('Null values', 'numbers.nullAs', [['skip', 'Leave out'], ['zero', 'Show as zero']]));
  }

  // ---------------------------------------------------------------------------
  // Lines & targets tab
  // ---------------------------------------------------------------------------
  function lineRows (g, base) {
    g.appendChild(checkboxRow('Show', base + '.show', rebuild));
    if (get(base + '.show')) {
      g.appendChild(colorRow('Color', base + '.color'));
      g.appendChild(numberRow('Width (px)', base + '.width', 0.5, 8, 0.5));
      g.appendChild(segRow('Style', base + '.style', LINE_STYLES));
    }
  }

  function buildLinesTab (p) {
    var vert = cfg.chart.orientation !== 'horizontal';
    lineRows(group(p, vert ? 'Value gridlines (horizontal)' : 'Value gridlines (vertical)'), 'lines.valueGrid');
    lineRows(group(p, 'Lines between categories'), 'lines.catGrid');
    lineRows(group(p, 'Zero line'), 'lines.zero');

    var gr = group(p, 'Reference lines and bands');
    gr.appendChild(help('Average, median, min, max, a percentile or a constant, across the bars. Set “Band to” to shade between two of them.'));
    var types = [['average', 'Average'], ['median', 'Median'], ['min', 'Minimum'], ['max', 'Maximum'], ['percentile', 'Percentile'], ['constant', 'Constant'], ['total', 'Total']];
    cfg.refs.forEach(function (r0, i) {
      cfg.refs[i] = Bc.refCfg(r0);
      var r = cfg.refs[i];
      var box = h('div', { className: 'subcard' });
      var base = ['refs', i];
      box.appendChild(checkboxRow('Show', P(base, 'show')));
      box.appendChild(selectRow('Line at', P(base, 'type'), types, null, rebuild));
      if (r.type === 'constant') box.appendChild(numberRow('Value', P(base, 'value'), -1e15, 1e15, 'any'));
      if (r.type === 'percentile' || r.bandTo === 'percentile') box.appendChild(numberRow('Percentile', P(base, 'percentile'), 0, 100, 1));
      if (info.series.length > 1) {
        box.appendChild(selectRow('Computed over', P(base, 'scope'), [['bars', 'All bars']].concat(info.series.map(function (s) { return ['series:' + s.key, s.name]; }))));
      }
      box.appendChild(selectRow('Band to', P(base, 'bandTo'), [['', 'No band (line only)']].concat(types), null, rebuild));
      if (r.bandTo) box.appendChild(rangeRow('Band opacity', P(base, 'bandOpacity'), 0, 60, 1, '%'));
      box.appendChild(textRow('Label', P(base, 'label'), '{type}: {value}'));
      box.appendChild(help('{type} and {value} are filled in. Empty = no label.'));
      box.appendChild(segRow('Label at', P(base, 'labelPos'), [['start', 'Start'], ['center', 'Middle'], ['end', 'End']]));
      box.appendChild(colorRow('Color', P(base, 'color')));
      box.appendChild(numberRow('Width (px)', P(base, 'width'), 0.5, 8, 0.5));
      box.appendChild(segRow('Style', P(base, 'style'), LINE_STYLES));
      var del = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Remove' });
      del.addEventListener('click', function () { cfg.refs.splice(i, 1); changed(); rebuild(); });
      box.appendChild(del);
      gr.appendChild(box);
    });
    var add = h('button', { type: 'button', className: 'btn', textContent: 'Add reference line' });
    add.addEventListener('click', function () { cfg.refs.push(Bc.clone(Bc.REF)); changed(); rebuild(); });
    gr.appendChild(add);

    var TG = cfg.target;
    var gt = group(p, 'Target markers (Target tile)');
    if (!info.hasTarget) gt.appendChild(h('p', { className: 'note', textContent: 'Drop a measure on the Target tile to draw a marker on every bar. Progress bars can fill up to it.' }));
    gt.appendChild(checkboxRow('Show targets', 'target.show', rebuild));
    if (TG.show) {
      gt.appendChild(segRow('Marker', 'target.style', [['line', 'Line'], ['dot', 'Dot'], ['triangle', 'Triangle'], ['none', 'Hidden']]));
      gt.appendChild(colorRow('Color', 'target.color'));
      gt.appendChild(numberRow('Width (px)', 'target.width', 0.5, 8, 0.5));
      gt.appendChild(rangeRow('Line beyond the bar', 'target.extend', 0, 60, 1, '%'));
      gt.appendChild(checkboxRow('Target in the tooltip', 'target.inTooltip'));
    }
  }

  // ---------------------------------------------------------------------------
  // Line tab (Line tile)
  // ---------------------------------------------------------------------------
  function buildLineTab (p) {
    if (!info.lines.length) {
      var g0 = group(p, 'Line over the bars');
      g0.appendChild(h('p', { className: 'note', textContent: 'Drop one or more measures on the Line tile to draw lines over the bars (e.g. a margin %, last year or a running total). The settings below are used for every line until you style one on its own.' }));
    }
    var base;
    if (info.lines.length) {
      var gs = group(p, 'Line to format');
      var r = row('Line');
      var sel = h('select');
      info.lines.forEach(function (l) { sel.appendChild(h('option', { value: l.key, textContent: (Bc.lineCfg(cfg, l.key).label || l.name) })); });
      if (!info.lines.some(function (l) { return l.key === selectedLine; })) selectedLine = info.lines[0].key;
      sel.value = selectedLine;
      sel.addEventListener('change', function () { selectedLine = sel.value; rebuild(); });
      r.appendChild(sel);
      gs.appendChild(r);
      cfg.lineSeries[selectedLine] = Bc.lineCfg(cfg, selectedLine);
      base = ['lineSeries', selectedLine];
      var lname = info.lines.find(function (l) { return l.key === selectedLine; }).name;
      gs.appendChild(textRow('Name', P(base, 'label'), lname));
    } else {
      base = ['lineDefaults'];
    }
    var L = get(base);
    var g1 = group(p, 'Line');
    g1.appendChild(optColorRow('Color', P(base, 'color'), '#17202B'));
    g1.appendChild(numberRow('Width (px)', P(base, 'width'), 0.5, 10, 0.5));
    g1.appendChild(segRow('Style', P(base, 'style'), LINE_STYLES));
    g1.appendChild(segRow('Shape', P(base, 'curve'), [['straight', 'Straight'], ['smooth', 'Smooth'], ['step', 'Steps']]));
    g1.appendChild(rangeRow('Opacity', P(base, 'opacity'), 5, 100, 1, '%'));
    g1.appendChild(checkboxRow('Fill area under the line', P(base, 'area'), rebuild));
    if (L.area) g1.appendChild(rangeRow('Area opacity', P(base, 'areaOpacity'), 1, 80, 1, '%'));
    var g2 = group(p, 'Markers');
    g2.appendChild(selectRow('Marker', P(base, 'marker'), [['circle', 'Circle'], ['ring', 'Ring'], ['square', 'Square'], ['diamond', 'Diamond'], ['hexagon', 'Hexagon'], ['none', 'None']]));
    g2.appendChild(numberRow('Size (px)', P(base, 'markerSize'), 2, 30, 1));
    g2.appendChild(segRow('Fill', P(base, 'markerFill'), [['white', 'White'], ['line', 'Line colour']]));
    var g3 = group(p, 'Values on the line');
    g3.appendChild(checkboxRow('Show values', P(base, 'labels'), rebuild));
    if (L.labels) {
      g3.appendChild(segRow('Place', P(base, 'labelPos'), [['above', 'Above'], ['below', 'Below'], ['right', 'Right']]));
      g3.appendChild(numberRow('Size (px)', P(base, 'labelSize'), 6, 30, 1));
      g3.appendChild(selectRow('Weight', P(base, 'labelWeight'), WEIGHTS));
      labelFmt(g3, P(base, 'fmt'));
    }
    if (info.lines.length > 1) {
      var gc = group(p, 'Copy');
      var cp = h('button', { type: 'button', className: 'btn', textContent: 'Apply these settings to every line' });
      cp.addEventListener('click', function () {
        var src = Bc.clone(get(base));
        info.lines.forEach(function (l) { var c = Bc.clone(src); c.label = Bc.lineCfg(cfg, l.key).label; c.color = Bc.lineCfg(cfg, l.key).color; cfg.lineSeries[l.key] = c; });
        var d = Bc.clone(src); d.label = ''; d.color = ''; cfg.lineDefaults = d;
        changed(); setStatus('Copied to every line (names and colours kept)');
      });
      gc.appendChild(cp);
    }

    var A = cfg.lineAxis;
    var g4 = group(p, 'Line axis');
    g4.appendChild(segRow('Axis', 'lineAxis.mode', [['secondary', 'Its own axis'], ['shared', 'The bars’ axis']], rebuild));
    if (A.mode === 'secondary') {
      g4.appendChild(checkboxRow('Same range as the bars', 'lineAxis.sync', rebuild));
      if (!A.sync) {
        g4.appendChild(segRow('Starts at', 'lineAxis.base', [['auto', 'Close to the data'], ['zero', 'Zero'], ['manual', 'Fixed']], rebuild));
        if (A.base === 'manual') g4.appendChild(numberRow('Minimum', 'lineAxis.manualMin', -1e15, 1e15, 'any'));
        g4.appendChild(segRow('Ends at', 'lineAxis.maxMode', [['auto', 'Automatic'], ['manual', 'Fixed']], rebuild));
        if (A.maxMode === 'manual') g4.appendChild(numberRow('Maximum', 'lineAxis.manualMax', -1e15, 1e15, 'any'));
      }
      g4.appendChild(checkboxRow('Show axis labels', 'lineAxis.show', rebuild));
      if (A.show) {
        g4.appendChild(textRow('Axis title', 'lineAxis.title', ''));
        g4.appendChild(numberRow('Size (px)', 'lineAxis.size', 6, 30, 1));
        g4.appendChild(colorRow('Color', 'lineAxis.color'));
        g4.appendChild(checkboxRow('Use shared format', 'lineAxis.useGlobalFormat', rebuild));
        if (!A.useGlobalFormat) fmtRows(g4, 'lineAxis.fmt', { noSign: true });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Legend tab
  // ---------------------------------------------------------------------------
  function buildLegendTab (p) {
    var L = cfg.legend;
    var g1 = group(p, 'Legend');
    g1.appendChild(checkboxRow('Show legend', 'legend.show', rebuild));
    if (!L.show) return;
    g1.appendChild(segRow('Position', 'legend.position', [['top', 'Top'], ['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']]));
    g1.appendChild(segRow('Align', 'legend.align', [['start', 'Start'], ['center', 'Center'], ['end', 'End']]));
    g1.appendChild(checkboxRow('Hide with a single item', 'legend.autoHide'));
    g1.appendChild(selectRow('Order', 'legend.sort', [['data', 'As in the chart'], ['name', 'Name, A to Z'], ['valDesc', 'Total, high to low']]));
    g1.appendChild(numberRow('Space between items (px)', 'legend.gap', 0, 60, 1));
    g1.appendChild(help('What the legend lists follows Colors → Colour by: series, categories, positive / negative, highlighted or a value gradient.'));

    var g2 = group(p, 'Items');
    g2.appendChild(selectRow('Marker', 'legend.marker', [['square', 'Square'], ['rounded', 'Rounded square'], ['circle', 'Circle'], ['bar', 'Bar'], ['line', 'Line']]));
    g2.appendChild(numberRow('Marker size (px)', 'legend.markerSize', 4, 30, 1));
    g2.appendChild(checkboxRow('Total next to each name', 'legend.showValues'));
    g2.appendChild(checkboxRow('Include Line tile measures', 'legend.includeLines'));
    g2.appendChild(checkboxRow('Include the target', 'legend.includeTarget'));
    g2.appendChild(checkboxRow('Include reference lines', 'legend.includeRefs'));

    var g3 = group(p, 'Title');
    g3.appendChild(checkboxRow('Show title', 'legend.showTitle', rebuild));
    if (L.showTitle) g3.appendChild(textRow('Title', 'legend.title', 'Defaults to the Color field'));

    var g4 = group(p, 'Text');
    fontRows(g4, 'legend', false);

    var g5 = group(p, 'Interaction');
    g5.appendChild(checkboxRow('Click to hide / show items', 'legend.interactive'));
    g5.appendChild(checkboxRow('Hover to highlight', 'legend.hoverHighlight'));
    g5.appendChild(help('Hidden items come back when the workbook is reopened.'));

    var g6 = group(p, 'Box');
    g6.appendChild(checkboxRow('Draw a box', 'legend.box', rebuild));
    if (L.box) {
      g6.appendChild(colorRow('Background', 'legend.boxColor'));
      g6.appendChild(colorRow('Border', 'legend.boxBorder'));
    }
  }

  // ---------------------------------------------------------------------------
  // Member icons tab
  // ---------------------------------------------------------------------------
  var openPicker = null; // member whose picker is open

  function buildIconsTab (p) {
    var IC = cfg.icons;
    var g1 = group(p, 'Icons for bars');
    g1.appendChild(checkboxRow('Show icons', 'icons.show', rebuild));
    g1.appendChild(help('Give each bar an icon: a built-in icon, a Tableau shape or your own image (logos, flags, photos).'));
    if (!IC.show) return;
    g1.appendChild(selectRow('Place', 'icons.placement', [
      ['axis', 'On the axis, next to the name'], ['base', 'Inside the bar, at the base'], ['middle', 'Inside the bar, middle'],
      ['end', 'Inside the bar, at the end'], ['outside', 'Beyond the bar end']
    ], null, rebuild));
    g1.appendChild(numberRow('Size (px)', 'icons.size', 8, 80, 1));
    g1.appendChild(numberRow('Gap (px)', 'icons.gap', 0, 40, 1));
    g1.appendChild(selectRow('Background', 'icons.bg', [['none', 'None'], ['square', 'Square'], ['rounded', 'Rounded square'], ['circle', 'Circle']], null, rebuild));
    if (IC.bg !== 'none') {
      g1.appendChild(segRow('Background color', 'icons.bgMode', [['bar', 'Bar colour'], ['tint', 'Light bar colour'], ['custom', 'Custom']], rebuild));
      if (IC.bgMode === 'custom') g1.appendChild(colorRow('Color', 'icons.bgColor'));
    }
    g1.appendChild(selectRow('Icon color', 'icons.tint', [['auto', 'Automatic'], ['bar', 'Bar colour'], ['white', 'White'], ['custom', 'Custom'], ['original', 'Original colours (images)']], null, rebuild));
    if (IC.tint === 'custom') g1.appendChild(colorRow('Color', 'icons.color'));
    if (IC.placement === 'axis') g1.appendChild(checkboxRow('Coloured accent next to the icon', 'icons.accent'));
    var fb = [['', 'None']].concat(Bc.ICONS.map(function (ic) { return [ic.id, ic.label]; }));
    g1.appendChild(selectRow('Members without an icon', 'icons.fallback', fb));

    var g2 = group(p, 'Icon per member');
    g2.appendChild(sourceRow('Each bar is', 'icons.by', true));
    g2.appendChild(help('Pick icons by the bar’s own name, by measure name, or by the value of one Dimension field (e.g. one icon per Category, shared by its Sub-Categories).'));
    var vals = sourceValues(IC.by);
    if (!vals.length) g2.appendChild(h('p', { className: 'note', textContent: 'No values yet.' }));
    var list = h('div', { className: 'memberlist' });
    list.style.maxHeight = 'none';
    vals.forEach(function (m) { list.appendChild(memberIconRow(m)); });
    g2.appendChild(list);
  }

  function iconPreview (slot, spec) {
    slot.innerHTML = '';
    if (!spec) { slot.textContent = '—'; slot.style.color = '#b0b6bf'; return; }
    if (spec.source === 'builtin') slot.innerHTML = Bc.iconHtml(spec.builtinId, cfg.icons.color || '#263244', 20).html;
    else if (spec.dataUrl) slot.appendChild(h('img', { src: spec.dataUrl, alt: '' }));
  }

  function memberIconRow (m) {
    var IC = cfg.icons;
    var wrap = h('div');
    var r = h('div', { className: 'member' });
    var slot = h('span', { className: 'mslot' });
    iconPreview(slot, IC.members[m]);
    var name = h('span', { className: 'mname', textContent: m, title: m });
    var ctl = h('div', { className: 'inline' });
    var sel = h('select');
    [['', 'No icon'], ['builtin', 'Built-in'], ['shape', 'Tableau shape'], ['upload', 'Upload']].forEach(function (o) { sel.appendChild(h('option', { value: o[0], textContent: o[1] })); });
    sel.value = IC.members[m] ? IC.members[m].source : '';
    var pick = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Choose…' });
    var file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp,image/bmp,.ico' });
    file.style.display = 'none';
    ctl.append(sel, pick, file);
    r.append(slot, name, ctl);
    wrap.appendChild(r);
    var pop = h('div', { className: 'picker-pop' });
    pop.hidden = openPicker !== m;
    wrap.appendChild(pop);

    var setSpec = function (spec) {
      if (spec) IC.members[m] = spec; else delete IC.members[m];
      changed();
      iconPreview(slot, spec);
    };
    var showPicker = function () {
      openPicker = m;
      pop.hidden = false;
      pop.innerHTML = '';
      if (sel.value === 'builtin') {
        var grid = h('div', { className: 'grid' });
        Bc.ICONS.forEach(function (icon) {
          var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
          cell.innerHTML = Bc.iconHtml(icon.id, '#263244', 20).html;
          if (IC.members[m] && IC.members[m].builtinId === icon.id) cell.classList.add('is-active');
          cell.addEventListener('click', function () { setSpec({ source: 'builtin', builtinId: icon.id }); pop.hidden = true; openPicker = null; });
          grid.appendChild(cell);
        });
        pop.appendChild(grid);
      } else if (sel.value === 'shape') {
        buildShapeGrid(pop, function (url, label) { setSpec({ source: 'shape', dataUrl: url, name: label }); pop.hidden = true; openPicker = null; });
      } else if (sel.value === 'upload') {
        pop.hidden = true;
        file.click();
      } else {
        pop.hidden = true;
      }
    };
    sel.addEventListener('change', function () {
      if (!sel.value) { setSpec(null); pop.hidden = true; return; }
      if (sel.value === 'builtin' && !(IC.members[m] && IC.members[m].source === 'builtin')) setSpec({ source: 'builtin', builtinId: 'fg-bar-chart-solid' });
      showPicker();
    });
    pick.addEventListener('click', function () {
      if (!sel.value) { sel.value = 'builtin'; setSpec({ source: 'builtin', builtinId: 'fg-bar-chart-solid' }); }
      if (!pop.hidden) { pop.hidden = true; openPicker = null; return; }
      showPicker();
    });
    file.addEventListener('change', function () {
      var f = file.files[0];
      if (!f) return;
      blobToIconDataUrl(f).then(function (url) { setSpec({ source: 'upload', dataUrl: url, name: f.name }); })
        .catch(function (e) { setStatus('Could not read that image: ' + e.message); });
    });
    if (openPicker === m) setTimeout(showPicker, 0);
    return wrap;
  }

  /** Grid of Tableau shapes (served by serve.py) — calls done(dataUrl, label). */
  function buildShapeGrid (body, done) {
    var note = h('p', { className: 'note', textContent: 'Loading shape palettes…' });
    body.appendChild(note);
    var loadIndex = shapeIndex ? Promise.resolve(shapeIndex)
      : fetch(baseUrl() + 'shapes/index.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (j) { shapeIndex = j; return j; });
    loadIndex.then(function (index) {
      var palettes = (index.palettes || []).filter(function (pl) { return pl.files && pl.files.length; });
      if (!palettes.length) { note.textContent = 'No shape palettes found. Use Upload instead.'; return; }
      note.textContent = '';
      var sel = h('select');
      palettes.forEach(function (pl, i) { sel.appendChild(h('option', { value: String(i), textContent: pl.name + ' (' + pl.files.length + ')' })); });
      body.appendChild(sel);
      var grid = h('div', { className: 'grid' });
      body.appendChild(grid);
      var fill = function () {
        grid.innerHTML = '';
        var pl = palettes[Number(sel.value)];
        pl.files.forEach(function (f) {
          var cell = h('button', { type: 'button', className: 'cell', title: f.name });
          cell.appendChild(h('img', { src: baseUrl() + f.url, alt: '', loading: 'lazy' }));
          cell.addEventListener('click', function () {
            fetch(baseUrl() + f.url).then(function (r) { return r.blob(); }).then(blobToIconDataUrl)
              .then(function (url) { done(url, pl.name + ' / ' + f.name); })
              .catch(function (e) { setStatus('Could not load that shape: ' + e.message); });
          });
          grid.appendChild(cell);
        });
      };
      sel.addEventListener('change', fill);
      fill();
    }).catch(function () {
      note.innerHTML = 'Tableau shapes are listed by the local helper server (<code>./serve.sh</code>). Use <b>Upload</b> to add a shape file instead.';
    });
  }

  // ---------------------------------------------------------------------------
  // Groups tab
  // ---------------------------------------------------------------------------
  function buildGroupsTab (p) {
    var G = cfg.groups;
    var g1 = group(p, 'Grouping of bars');
    g1.appendChild(segRow('Groups', 'groups.mode', [['auto', 'Automatic'], ['custom', 'Custom'], ['none', 'None']], rebuild));
    g1.appendChild(help(G.mode === 'auto'
      ? 'Bars are grouped by the outer Dimension fields on the axis (e.g. Category › Sub-Category) and by their parent while drilled down.'
      : G.mode === 'custom' ? 'Make groups below and pick each bar’s group. Neighbouring bars in the same group share one label; sort the bars so groups stay together.'
        : 'No group labels under the axis.'));

    if (G.mode === 'custom') {
      var ids = Object.keys(G.custom);
      var gl = group(p, 'Groups');
      if (!ids.length) gl.appendChild(h('p', { className: 'note', textContent: 'No groups yet.' }));
      ids.forEach(function (id) {
        var box = h('div', { className: 'subcard' });
        box.appendChild(textRow('Text', ['groups', 'custom', id, 'text'], 'Group name'));
        box.appendChild(colorRow('Line color', ['groups', 'custom', id, 'color']));
        var del = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Remove group' });
        del.addEventListener('click', function () {
          delete G.custom[id];
          Object.keys(G.assign).forEach(function (k) { if (G.assign[k] === id) delete G.assign[k]; });
          changed(); rebuild();
        });
        box.appendChild(del);
        gl.appendChild(box);
      });
      var add = h('button', { type: 'button', className: 'btn', textContent: 'Add group' });
      add.addEventListener('click', function () {
        var n = 1;
        while (G.custom['g' + n]) n++;
        G.custom['g' + n] = { text: 'Group ' + n, color: G.color };
        changed(); rebuild();
      });
      gl.appendChild(add);
      if (ids.length) {
        var ga = group(p, 'Which group each bar is in');
        ga.appendChild(sourceRow('Each bar is', 'groups.assignBy', true));
        ga.appendChild(help('Assign by the bar’s own name, by measure name (bars that are measures), or by the value of one Dimension field.'));
        sourceValues(G.assignBy).forEach(function (m) {
          ga.appendChild(selectRow(m, ['groups', 'assign', m], [['', 'None']].concat(ids.map(function (id) { return [id, G.custom[id].text || id]; }))));
        });
      }
    }

    if (G.mode !== 'none') {
      var gs = group(p, 'Style');
      gs.appendChild(selectRow('Line', 'groups.lineStyle', LINE_STYLES.concat([['bracket', 'Bracket'], ['none', 'No line']])));
      gs.appendChild(numberRow('Line width', 'groups.lineWidth', 0.5, 8, 0.5));
      if (G.mode !== 'custom') gs.appendChild(colorRow('Line color', 'groups.color'));
      gs.appendChild(numberRow('Text size (px)', 'groups.size', 6, 36, 1));
      gs.appendChild(selectRow('Text weight', 'groups.weight', WEIGHTS));
      gs.appendChild(colorRow('Text color', 'groups.textColor'));
      gs.appendChild(checkboxRow('Group total', 'groups.showTotal', rebuild));
      if (G.showTotal) gs.appendChild(textRow('Separator', 'groups.separator', ' · '));
      gs.appendChild(checkboxRow('Shade behind bars', 'groups.band', rebuild));
      if (G.band) gs.appendChild(rangeRow('Shade opacity', 'groups.bandOpacity', 1, 40, 1, '%'));
      gs.appendChild(help('The space between groups is on the Bars tab.'));
      if (G.showTotal) { var gf = group(p, 'Group total format'); labelFmt(gf, 'groups.fmt'); }
    }
  }

  // ---------------------------------------------------------------------------
  // Breakdown & drill tab
  // ---------------------------------------------------------------------------
  function effectiveDims (bd) {
    var keys = info.dims.map(function (d) { return d.key; });
    var sel = (bd.dims || []).filter(function (k) { return keys.indexOf(k) >= 0; });
    return sel.length ? sel : keys;
  }

  function memberList (bd) {
    var idx = effectiveDims(bd).map(function (k) { return info.dims.findIndex(function (d) { return d.key === k; }); });
    var seen = {};
    var out = [];
    info.combos.forEach(function (c) {
      var n = idx.map(function (i) { return c[i]; }).join(bd.sep == null ? ' · ' : bd.sep);
      if (!seen[n]) { seen[n] = 1; out.push(n); }
    });
    return out;
  }

  function dimPicker (g, bd) {
    var selected = effectiveDims(bd);
    var others = info.dims.map(function (d) { return d.key; }).filter(function (k) { return selected.indexOf(k) < 0; });
    var nameOf = function (k) { var d = info.dims.find(function (x) { return x.key === k; }); return d ? d.name : k; };
    var r = row('Dimensions');
    var list = h('div', { className: 'dimlist' });
    var save = function (keys) {
      if (!keys.length) { setStatus('Keep at least one dimension, or untick Split bars'); rebuild(); return; }
      set('breakdown.dims', keys);
      rebuild();
    };
    selected.concat(others).forEach(function (k) {
      var on = selected.indexOf(k) >= 0;
      var pos = selected.indexOf(k);
      var item = h('div', { className: 'dimitem' + (on ? '' : ' is-off') });
      var cb = h('input', { type: 'checkbox' });
      cb.checked = on;
      cb.addEventListener('change', function () { save(cb.checked ? selected.concat([k]) : selected.filter(function (x) { return x !== k; })); });
      var label = h('span', { className: 'dimname', textContent: (on && selected.length > 1 ? (pos + 1) + '. ' : '') + nameOf(k) });
      var up = h('button', { type: 'button', className: 'mini', textContent: '▲', title: 'Earlier in the name' });
      var down = h('button', { type: 'button', className: 'mini', textContent: '▼', title: 'Later in the name' });
      up.disabled = !on || pos === 0;
      down.disabled = !on || pos === selected.length - 1;
      var move = function (d) { var a = selected.slice(); var t = a[pos]; a[pos] = a[pos + d]; a[pos + d] = t; save(a); };
      up.addEventListener('click', function () { move(-1); });
      down.addEventListener('click', function () { move(1); });
      item.append(cb, label, up, down);
      list.appendChild(item);
    });
    r.appendChild(list);
    g.appendChild(r);
    if (selected.length > 1) g.appendChild(textRow('Name separator', 'breakdown.sep', ' · '));
  }

  function buildBreakdownTab (p) {
    var BD = cfg.breakdown;
    var g1 = group(p, 'Bar segments (breakdown fields)');
    if (!info.dims.length) g1.appendChild(h('p', { className: 'note', textContent: 'Put more dimensions on the Dimension tile than the bars use (Chart type → Bars are). The extra fields are listed in the tooltip, can split the bars into segments, and are the levels you drill down into.' }));
    g1.appendChild(checkboxRow('Split bars into segments', 'breakdown.show', rebuild));
    g1.appendChild(help('Segments are shades of the bar’s colour (or your own colours). The tooltip always lists the breakdown.'));
    if (BD.show) {
      if (info.dims.length) dimPicker(g1, BD);
      g1.appendChild(selectRow('Segment order', 'breakdown.order', Bc.BREAKDOWN_ORDERS));
      g1.appendChild(help('Order of the segments from the bar’s base.'));
      g1.appendChild(segRow('Colors', 'breakdown.colorMode', [['shades', 'Shades of bar colour'], ['custom', 'Custom']], rebuild));
      if (BD.colorMode === 'custom') {
        var members = memberList(BD);
        if (!members.length) g1.appendChild(help('No breakdown members in the data yet.'));
        var sh = Bc.shades('#2F4B7C', Math.max(1, members.length));
        members.forEach(function (m, i) {
          if (!BD.colors[m]) BD.colors[m] = sh[i];
          g1.appendChild(colorRow(m, ['breakdown', 'colors', m]));
        });
      }
      g1.appendChild(checkboxRow('Thin divider lines', 'breakdown.dividers'));
      g1.appendChild(checkboxRow('Show segment values', 'breakdown.showValues', rebuild));
      if (BD.showValues) {
        g1.appendChild(checkboxRow('Include member name', 'breakdown.showNames'));
        g1.appendChild(segRow('Place', 'breakdown.position', [['inside', 'Inside'], ['left', 'Left / below'], ['right', 'Right / above']]));
        g1.appendChild(numberRow('Size (px)', 'breakdown.size', 6, 36, 1));
        g1.appendChild(selectRow('Weight', 'breakdown.weight', WEIGHTS));
        g1.appendChild(segRow('Text color', 'breakdown.labelColorMode', [['auto', 'Automatic'], ['custom', 'Custom']], rebuild));
        if (BD.labelColorMode === 'custom') g1.appendChild(colorRow('Color', 'breakdown.labelColor'));
        g1.appendChild(numberRow('Hide below (px)', 'breakdown.minPx', 0, 80, 1));
        labelFmt(g1, 'breakdown.fmt');
      }
    }

    var D = cfg.drill;
    var g2 = group(p, 'Drill down (double-click a bar)');
    g2.appendChild(checkboxRow('Drill down into the breakdown fields', 'drill.enabled', rebuild));
    if (D.enabled) {
      g2.appendChild(choiceRow('', 'drill.mode', [
        ['expandOne', 'Expand that bar, keep the others', { vals: [0.8, 0.3, 0.25, 0.2, 0.6], colors: ['#2F4B7C', '#6D81A3', '#97A5BD', '#C1C9D7', '#2F4B7C'] }],
        ['focus', 'Show only that bar’s detail', { vals: [0.6, 0.45, 0.3, 0.2], colors: ['#2F4B7C', '#6D81A3', '#97A5BD', '#C1C9D7'] }],
        ['expandAll', 'Expand every bar', { vals: [0.5, 0.3, 0.45, 0.25, 0.4, 0.2], colors: ['#2F4B7C', '#97A5BD'] }]
      ]));
      g2.appendChild(checkboxRow('Child bars in shades of the parent', 'drill.tintChildren'));
      g2.appendChild(checkboxRow('Back / Reset bar above the chart', 'drill.showBar'));
      g2.appendChild(help('Each double-click goes one breakdown field (the next Dimension field) deeper. Double-click a child (or right-click → Drill up / Collapse) to go back. Drill-down isn’t saved: the workbook always opens at the top level.'));
    }
  }

  // ---------------------------------------------------------------------------
  // Tooltip & actions tab
  // ---------------------------------------------------------------------------
  function buildTooltipTab (p) {
    var T = cfg.tooltip;
    var g1 = group(p, 'Tooltip');
    g1.appendChild(checkboxRow('Tooltip on hover', 'tooltip.show', rebuild));
    if (T.show) {
      g1.appendChild(checkboxRow('Full numbers (no K / M / B)', 'tooltip.fullNumbers'));
      g1.appendChild(checkboxRow('% of total, of the category and vs previous', 'tooltip.showPct'));
      g1.appendChild(checkboxRow('Series name', 'tooltip.showSeries'));
      g1.appendChild(checkboxRow('Breakdown members', 'tooltip.showBreakdown'));
      g1.appendChild(checkboxRow('Line tile values', 'tooltip.showLines'));
      g1.appendChild(checkboxRow('Tooltip tile measures', 'tooltip.showExtra'));
      g1.appendChild(selectRow('Sort the list', 'tooltip.sort', [['valDesc', 'Value, high to low'], ['valAsc', 'Value, low to high'], ['name', 'Name, A to Z'], ['nameDesc', 'Name, Z to A'], ['data', 'As in the data']]));
      g1.appendChild(numberRow('Rows on hover', 'tooltip.maxRows', 1, 100, 1));
      g1.appendChild(checkboxRow('Click a bar to pin its tooltip', 'tooltip.pinOnClick'));
      g1.appendChild(help('A pinned tooltip lists every row and can be sorted by clicking its Name / Value headers.'));
    }
    var g2 = group(p, 'Actions');
    g2.appendChild(checkboxRow('Right-click menu', 'interaction.rightClickMenu'));
    g2.appendChild(help('Format, comments, drill, keep only / hide, highlight and quick links to the Format tabs.'));
    g2.appendChild(selectRow('Double-click a bar', 'interaction.dblclick', [['drill', 'Drill down (next Dimension field)'], ['format', 'Open its colour settings'], ['none', 'Nothing']]));
    g2.appendChild(checkboxRow('Click selects the bar in Tableau', 'interaction.selectInTableau'));
    g2.appendChild(help('Lets dashboard filter and highlight actions use the clicked category. Works where Tableau allows extensions to select marks.'));
  }

  // ---------------------------------------------------------------------------
  // Comments tab
  // ---------------------------------------------------------------------------
  function barLabelOf (key) {
    var b = info.bars.find(function (x) { return x.key === key; });
    return b ? (b.path || b.label) : key.split(/[\u0001\u0003]/).join(' › ');
  }

  function buildCommentsTab (p) {
    var C = cfg.comments;
    var g1 = group(p, 'Comments on bars');
    g1.appendChild(checkboxRow('Show comments', 'comments.show', rebuild));
    g1.appendChild(help('Right-click a bar → Add comment, or add one below. Comments are saved in the workbook (while editing it) and show in the tooltip.'));
    g1.appendChild(segRow('Show as', 'comments.display', [['marker', 'Marker (hover to read)'], ['callout', 'Callout with the text']]));
    g1.appendChild(segRow('Marker', 'comments.marker', [['dot', 'Dot'], ['flag', 'Flag'], ['pin', 'Pin'], ['bubble', 'Bubble']]));
    g1.appendChild(colorRow('Color', 'comments.color'));
    g1.appendChild(numberRow('Callout text size', 'comments.size', 7, 24, 1));
    g1.appendChild(numberRow('Callout max width', 'comments.maxWidth', 40, 600, 10));
    g1.appendChild(textRow('Your name (author)', 'comments.author', 'Optional'));

    var g2 = group(p, 'All comments');
    var keys = Object.keys(C.items).filter(function (k) { return C.items[k] && C.items[k].length; });
    if (!keys.length) g2.appendChild(h('p', { className: 'note', textContent: 'No comments yet.' }));
    keys.forEach(function (k) {
      C.items[k].forEach(function (c, i) {
        var box = h('div', { className: 'comment' });
        var meta = h('div', { className: 'meta' });
        meta.append(h('b', { textContent: barLabelOf(k) }), h('span', { className: 'sp' }), h('span', { textContent: [c.author, c.date].filter(Boolean).join(' · ') }));
        var col = h('input', { type: 'color', value: Bc.normalizeHex(c.color) || Bc.normalizeHex(C.color) || '#EB644C', title: 'Marker colour' });
        col.addEventListener('input', function () { c.color = col.value.toUpperCase(); changed(); });
        var del = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Delete' });
        del.addEventListener('click', function () { C.items[k].splice(i, 1); if (!C.items[k].length) delete C.items[k]; changed(); rebuild(); });
        meta.append(col, del);
        var ta = h('textarea');
        ta.value = c.text;
        ta.addEventListener('input', function () { c.text = ta.value; changed(); });
        box.append(meta, ta);
        g2.appendChild(box);
      });
    });

    var g3 = group(p, 'Add a comment');
    if (!info.bars.length) { g3.appendChild(h('p', { className: 'note', textContent: 'Open this dialog from the chart to list its bars.' })); return; }
    var r = row('Bar');
    var sel = h('select');
    info.bars.forEach(function (b) { sel.appendChild(h('option', { value: b.key, textContent: b.path || b.label })); });
    r.appendChild(sel);
    g3.appendChild(r);
    var ta2 = h('textarea', { placeholder: 'Comment text' });
    g3.appendChild(ta2);
    var add = h('button', { type: 'button', className: 'btn', textContent: 'Add comment' });
    add.style.marginTop = '6px';
    add.addEventListener('click', function () {
      var t = ta2.value.trim();
      if (!t) return;
      var d = new Date();
      (C.items[sel.value] = C.items[sel.value] || []).push({ id: 'n' + Date.now().toString(36), text: t, author: C.author || '', date: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2), color: '' });
      changed(); rebuild();
    });
    g3.appendChild(add);
  }

  // ---------------------------------------------------------------------------
  // Numbers + Card tabs
  // ---------------------------------------------------------------------------
  function allLabelFmtPaths () {
    var paths = [['labels', 'fmt'], ['labels', 'totalFmt'], ['groups', 'fmt'], ['breakdown', 'fmt'], ['lineDefaults', 'fmt']];
    var keys = {};
    info.lines.forEach(function (l) { keys[l.key] = 1; });
    Object.keys(cfg.lineSeries).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      cfg.lineSeries[k] = Bc.lineCfg(cfg, k);
      paths.push(['lineSeries', k, 'fmt']);
    });
    return paths;
  }

  function copyGlobalToAll () {
    allLabelFmtPaths().forEach(function (pth) {
      var last = pth[pth.length - 1];
      pth.slice(0, -1).reduce(function (o, k) { return o[k]; }, cfg)[last] = Bc.clone(cfg.format);
    });
    changed();
  }

  function buildNumbersTab (p) {
    var g1 = group(p, 'Scope');
    g1.appendChild(segRow('Format', 'numbers.mode', [['all', 'All numbers the same'], ['each', 'Each part its own']], function () {
      if (cfg.numbers.mode === 'each') copyGlobalToAll();
      rebuild();
    }));
    g1.appendChild(help(cfg.numbers.mode === 'all'
      ? 'Bar values, stack totals, segment values, line values, group totals and tooltips use the format below. The axes have their own (Axes and Line tabs).'
      : 'Labels, stack totals, segments, lines and group totals each have their own format on their tabs. They started as copies of the format below.'));
    var g2 = group(p, cfg.numbers.mode === 'all' ? 'Number format' : 'Shared format (tooltips)');
    fmtRows(g2, 'format');
    if (cfg.numbers.mode === 'each') {
      var btn = h('button', { type: 'button', className: 'btn', textContent: 'Copy this format to every part' });
      btn.addEventListener('click', function () { copyGlobalToAll(); setStatus('Copied to every part'); });
      g2.appendChild(btn);
    }
    var g3 = group(p, 'Chart text');
    g3.appendChild(fontFamilyRow('Font', 'numbers.font'));
    g3.appendChild(help('Font of values, totals, segment and group labels and the tooltip. Axis and legend fonts are on their tabs.'));
  }

  function buildCardTab (p) {
    var g1 = group(p, 'Card');
    g1.appendChild(numberRow('Padding (px)', 'card.padding', 0, 60, 1));
    g1.appendChild(numberRow('Space above chart', 'card.gap', 0, 60, 1));

    var g2 = group(p, 'Background');
    g2.appendChild(colorRow('Color', 'card.bgColor'));
    g2.appendChild(rangeRow('Opacity', 'card.bgOpacity', 0, 100, 1, '%'));
    g2.appendChild(help('0% is fully transparent. Set worksheet and container shading to None in Tableau to see through.'));

    var g3 = group(p, 'Chart area background');
    g3.appendChild(colorRow('Color', 'card.plotBg'));
    g3.appendChild(rangeRow('Opacity', 'card.plotBgOpacity', 0, 100, 1, '%'));
    g3.appendChild(help('Shades only the area with the bars and axes, e.g. a dark panel under light bars.'));
  }

  function help (text) { return h('div', { className: 'help', textContent: text }); }

  /** Path helper: P('a.b', 'c.d') or P(['series', key], 'label') → array. */
  function P (base, rest) {
    var a = Array.isArray(base) ? base.slice() : String(base).split('.');
    return rest == null ? a : a.concat(String(rest).split('.'));
  }
  function buildIconTab (p) {
    var ic = cfg.icon;

    var preview = h('div', { className: 'icon-preview' });
    var slot = h('div', { className: 'slot' });
    var name = h('div', { className: 'name' });
    preview.append(slot, name);
    var refreshPreview = function () {
      slot.innerHTML = '';
      slot.classList.remove('slot--dark');
      if (!ic.show) { name.textContent = 'Icon hidden'; return; }
      if (ic.source === 'builtin') {
        var r = Bc.iconHtml(ic.builtinId, ic.color);
        slot.innerHTML = r.html;
        slot.classList.toggle('slot--dark', !!r.icon.light);
        name.textContent = r.icon.label;
      } else if (ic.dataUrl) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || 24; var hh = img.naturalHeight || 24;
          if (w >= hh) { img.style.width = '24px'; img.style.height = 'auto'; } else { img.style.height = '24px'; img.style.width = 'auto'; }
        };
        img.src = ic.dataUrl;
        slot.appendChild(img);
        name.textContent = ic.name || (ic.source === 'shape' ? 'Tableau shape' : 'Uploaded image');
      } else {
        name.textContent = 'No image chosen yet';
      }
    };
    refreshPreview();

    var g = group(p, 'Icon');
    g.appendChild(preview);
    g.appendChild(checkboxRow('Show icon', 'icon.show', function () { refreshPreview(); }));
    g.appendChild(rangeRow('Size', 'icon.size', 12, 96, 1, ' px'));
    g.appendChild(h('div', { className: 'help', textContent: 'Length of the icon\u2019s longer side. Figma default is 24 px; icons stay sharpest up to about 48 px.' }));

    var sources = [['builtin', 'Built-in'], ['shape', 'Tableau shapes'], ['upload', 'Upload']];
    var sourceRow = row('Source');
    var seg = h('div', { className: 'seg' });
    sources.forEach(function (s) {
      var b = h('button', { type: 'button', textContent: s[1] });
      b.setAttribute('aria-pressed', String(ic.source === s[0]));
      b.addEventListener('click', function () {
        ic.source = s[0];
        if (s[0] === 'builtin') ic.show = true;
        changed();
        buildTabs();
      });
      seg.appendChild(b);
    });
    sourceRow.appendChild(seg);
    g.appendChild(sourceRow);

    var body = group(p, sources.find(function (s) { return s[0] === ic.source; })[1]);

    if (ic.source === 'builtin') {
      var gridWrap = h('div');
      var fillGrid = function () {
        gridWrap.innerHTML = '';
        Bc.ICON_GROUPS.forEach(function (groupName) {
          var icons = Bc.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = Bc.iconHtml(icon.id, ic.color).html;
            if (icon.id === ic.builtinId) cell.classList.add('is-active');
            cell.addEventListener('click', function () {
              ic.builtinId = icon.id;
              ic.show = true;
              Array.prototype.forEach.call(gridWrap.querySelectorAll('.cell'), function (c) { c.classList.remove('is-active'); });
              cell.classList.add('is-active');
              changed();
              refreshPreview();
            });
            grid.appendChild(cell);
          });
          gridWrap.appendChild(grid);
        });
      };
      body.appendChild(colorRow('Icon color', 'icon.color', function () { refreshPreview(); fillGrid(); }));
      body.appendChild(h('div', { className: 'help', textContent: 'Recolours the built-in icons.' }));
      fillGrid();
      body.appendChild(gridWrap);
    } else if (ic.source === 'shape') {
      buildShapePicker(body, refreshPreview);
    } else {
      buildUpload(body, refreshPreview);
    }
  }

  /** Lists Tableau shape palettes served by serve.py (/shapes/index.json). */
  function buildShapePicker (body, refreshPreview) {
    var note = h('p', { className: 'note', textContent: 'Loading shape palettes…' });
    body.appendChild(note);

    var loadIndex = shapeIndex ? Promise.resolve(shapeIndex)
      : fetch(baseUrl() + 'shapes/index.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (j) { shapeIndex = j; return j; });

    loadIndex.then(function (index) {
      var palettes = (index.palettes || []).filter(function (pl) { return pl.files && pl.files.length; });
      if (!palettes.length) {
        note.innerHTML = 'No shape palettes found. serve.py looked in:<br><code>' +
          (index.searched || []).map(escapeHtml).join('</code><br><code>') +
          '</code><br>Set <code>KPI_SHAPES_DIRS</code> before starting it to add folders.';
        return;
      }
      note.textContent = 'Shapes are copied into the workbook when picked, so they keep working after publishing.';

      var selRow = row('Palette');
      var sel = h('select');
      palettes.forEach(function (pl, i) { sel.appendChild(h('option', { value: String(i), textContent: pl.name + ' (' + pl.files.length + ')' })); });
      var remembered = palettes.findIndex(function (pl) { return cfg.icon.name.indexOf(pl.name + ' / ') === 0; });
      sel.value = String(remembered >= 0 ? remembered : 0);
      selRow.appendChild(sel);
      body.appendChild(selRow);

      var grid = h('div', { className: 'grid' });
      body.appendChild(grid);

      var fill = function () {
        grid.innerHTML = '';
        var pl = palettes[Number(sel.value)];
        pl.files.forEach(function (f) {
          var label = pl.name + ' / ' + f.name;
          var cell = h('button', { type: 'button', className: 'cell', title: f.name });
          cell.appendChild(h('img', { src: baseUrl() + f.url, alt: '', loading: 'lazy' }));
          if (cfg.icon.source === 'shape' && cfg.icon.name === label) cell.classList.add('is-active');
          cell.addEventListener('click', function () {
            fetch(baseUrl() + f.url).then(function (r) { return r.blob(); })
              .then(blobToIconDataUrl)
              .then(function (url) {
                cfg.icon.source = 'shape';
                cfg.icon.dataUrl = url;
                cfg.icon.name = label;
                cfg.icon.show = true;
                Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('is-active'); });
                cell.classList.add('is-active');
                changed();
                refreshPreview();
              })
              .catch(function (e) { setStatus('Could not load that shape: ' + e.message); });
          });
          grid.appendChild(cell);
        });
      };
      sel.addEventListener('change', fill);
      fill();
    }).catch(function () {
      note.innerHTML = 'Tableau shapes are listed by the local helper server. Start the extension with ' +
        '<code>./serve.sh</code> (it runs <code>serve.py</code>), then reopen this dialog. ' +
        'You can still upload a shape file from the <b>Upload</b> tab.';
    });
  }

  function buildUpload (body, refreshPreview) {
    var drop = h('label', { className: 'drop' });
    var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp,image/bmp,.ico' });
    drop.append(input,
      h('b', { textContent: 'Choose an image' }),
      h('span', { textContent: 'or drop it here — PNG, SVG, JPG, GIF. Tableau custom shapes work too.' }));
    body.appendChild(drop);
    body.appendChild(h('p', {
      className: 'note',
      textContent: 'Scaled to 24 px on its longer side. Raster images are stored at 96 px for sharp rendering on high-DPI screens.'
    }));

    var take = function (file) {
      if (!file) return;
      blobToIconDataUrl(file).then(function (url) {
        cfg.icon.source = 'upload';
        cfg.icon.dataUrl = url;
        cfg.icon.name = file.name;
        cfg.icon.show = true;
        changed();
        refreshPreview();
      }).catch(function (e) { setStatus('Could not read that image: ' + e.message); });
    };
    input.addEventListener('change', function () { take(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) { take(e.dataTransfer.files[0]); });
  }

  function buildTextTab (p) {
    var g1 = group(p, 'Title');
    g1.appendChild(checkboxRow('Show title', 'title.show'));
    g1.appendChild(textRow('Title', 'title.text', 'Defaults to the measure names'));
    g1.appendChild(segRow('Alignment', 'title.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
    g1.appendChild(h('div', { className: 'help', textContent: 'The explanation text follows the same alignment.' }));
    fontRows(g1, 'title');

    var g2 = group(p, 'Explanation text');
    g2.appendChild(checkboxRow('Show explanation', 'explanation.show'));
    g2.appendChild(checkboxRow('Keep space when empty', 'explanation.reserveSpace'));
    g2.appendChild(h('div', { className: 'help', textContent: 'Reserves the explanation line even when it is empty or hidden, so charts line up across a dashboard.' }));
    g2.appendChild(textRow('Text', 'explanation.text', 'e.g. % Top-Up vs Local Transfer'));
    fontRows(g2, 'explanation', true);
  }

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------
  function fontRows (g, section, withItalic) {
    g.appendChild(fontFamilyRow('Font', P(section, 'font')));
    g.appendChild(numberRow('Size (px)', P(section, 'size'), 6, 160, 1));
    g.appendChild(selectRow('Weight', P(section, 'weight'), WEIGHTS));
    g.appendChild(colorRow('Color', P(section, 'color')));
    if (withItalic !== false) g.appendChild(checkboxRow('Italic', P(section, 'italic')));
  }

  function fontFamilyRow (label, path) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var sel = h('select');
    Bc.FONTS.forEach(function (f) { sel.appendChild(h('option', { value: f, textContent: f })); });
    sel.appendChild(h('option', { value: '__custom', textContent: 'Other…' }));
    var custom = h('input', { type: 'text', placeholder: 'Installed font name' });
    var current = get(path);
    if (Bc.FONTS.indexOf(current) >= 0) { sel.value = current; custom.hidden = true; } else { sel.value = '__custom'; custom.value = current; }
    sel.addEventListener('change', function () {
      custom.hidden = sel.value !== '__custom';
      if (sel.value !== '__custom') { set(path, sel.value); } else { custom.focus(); }
    });
    custom.addEventListener('input', function () { if (custom.value.trim()) set(path, custom.value.trim()); });
    wrap.append(sel, custom);
    r.appendChild(wrap);
    return r;
  }

  function textRow (label, path, placeholder) {
    var r = row(label);
    var cur = get(path);
    var input = h('input', { type: 'text', value: cur == null ? '' : cur, placeholder: placeholder || '' });
    input.addEventListener('input', function () { set(path, input.value); });
    r.appendChild(input);
    return r;
  }

  function numberRow (label, path, min, max, step) {
    var r = row(label);
    var input = h('input', { type: 'number', min: min, max: max, step: step, value: get(path) });
    input.addEventListener('input', function () {
      var n = Number(input.value);
      if (input.value === '' || !isFinite(n)) return;
      set(path, Math.max(min, Math.min(max, n)));
    });
    r.appendChild(input);
    return r;
  }

  function rangeRow (label, path, min, max, step, unit) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var input = h('input', { type: 'range', min: min, max: max, step: step, value: get(path) });
    var out = h('span', { className: 'readout', textContent: get(path) + (unit || '') });
    input.addEventListener('input', function () { set(path, Number(input.value)); out.textContent = input.value + (unit || ''); });
    wrap.append(input, out);
    r.appendChild(wrap);
    return r;
  }

  function selectRow (label, path, options, help, after) {
    var r = row(label);
    var sel = h('select');
    options.forEach(function (o) { sel.appendChild(h('option', { value: String(o[0]), textContent: o[1] })); });
    sel.value = String(get(path));
    if (sel.selectedIndex < 0) sel.selectedIndex = 0;
    sel.addEventListener('change', function () {
      var orig = options.find(function (o) { return String(o[0]) === sel.value; })[0];
      set(path, orig);
      if (after) after();
    });
    r.appendChild(sel);
    if (help) { var frag = document.createDocumentFragment(); frag.append(r, h('div', { className: 'help', textContent: help })); return wrapRows(frag); }
    return r;
  }

  function segRow (label, path, options, after) {
    var r = row(label);
    var seg = h('div', { className: 'seg' });
    options.forEach(function (o) {
      var b = h('button', { type: 'button', textContent: o[1] });
      b.setAttribute('aria-pressed', String(get(path) === o[0]));
      b.addEventListener('click', function () {
        set(path, o[0]);
        Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        if (after) after();
      });
      seg.appendChild(b);
    });
    r.appendChild(seg);
    return r;
  }

  function checkboxRow (label, path, after) {
    var r = row(label);
    var input = h('input', { type: 'checkbox' });
    input.checked = !!get(path);
    input.addEventListener('change', function () { set(path, input.checked); if (after) after(); });
    r.appendChild(h('div', { className: 'inline' }, [input]));
    return r;
  }

  function colorRow (label, path, after) {
    var r = row(label);
    var wrap = h('div', { className: 'inline' });
    var picker = h('input', { type: 'color', value: Bc.normalizeHex(get(path)) || '#000000' });
    var hex = h('input', { type: 'text', className: 'hex', value: get(path), maxLength: 7, spellcheck: false });
    picker.addEventListener('input', function () {
      hex.value = picker.value.toUpperCase(); hex.classList.remove('is-invalid');
      set(path, hex.value); if (after) after();
    });
    hex.addEventListener('input', function () {
      var v = Bc.normalizeHex(hex.value);
      hex.classList.toggle('is-invalid', !v);
      if (v) { picker.value = v; set(path, v); if (after) after(); }
    });
    hex.addEventListener('blur', function () { hex.value = get(path); hex.classList.remove('is-invalid'); });
    wrap.append(picker, hex);
    r.appendChild(wrap);
    return r;
  }

  function wrapRows (frag) { var d = h('div'); d.appendChild(frag); return d; }

  function row (label) {
    var r = h('div', { className: 'row' });
    r.appendChild(h('label', { textContent: label }));
    return r;
  }

  function group (parent, title) {
    var g = h('div', { className: 'group' });
    g.appendChild(h('h3', { className: 'group-title', textContent: title }));
    parent.appendChild(g);
    return g;
  }

  function h (tag, props, children) {
    var n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'role') n.setAttribute('role', props[k]); else n[k] = props[k];
    });
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  // ---------------------------------------------------------------------------
  // Images
  // ---------------------------------------------------------------------------

  /**
   * Converts an image file/blob into a compact data URL for the workbook.
   * Small SVGs are kept as vectors; everything else is rasterised so its
   * longer side is 96 px (4× the 24 px display size).
   */
  function blobToIconDataUrl (blob) {
    return readAsDataUrl(blob).then(function (url) {
      var isSvg = /svg/i.test(blob.type) || /^data:image\/svg/i.test(url);
      if (isSvg && url.length < 60000) return url;
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || 96;
          var hh = img.naturalHeight || 96;
          var k = 96 / Math.max(w, hh);
          if (k >= 1 && url.length < 60000) { resolve(url); return; }
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * Math.min(k, 1)));
          c.height = Math.max(1, Math.round(hh * Math.min(k, 1)));
          var ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = function () { reject(new Error('unsupported image format')); };
        img.src = url;
      });
    });
  }

  function readAsDataUrl (blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  function get (path) {
    return P(path).reduce(function (o, k) { return o == null ? undefined : o[k]; }, cfg);
  }

  function set (path, value) {
    var keys = P(path);
    var last = keys.pop();
    keys.reduce(function (o, k) {
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      return o[k];
    }, cfg)[last] = value;
    changed();
  }

  function changed () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 180);
  }

  function flush () {
    clearTimeout(saveTimer);
    return persist();
  }

  function persist () {
    try {
      setStatus('Saving…');
      return Bc.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function setStatus (text) {
    document.getElementById('status').textContent = text;
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }

  function baseUrl () {
    return window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
  }

  function escapeHtml (s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }


  window.BarChartConfigure = { init: init };
})();
