'use strict';

/**
 * Bar Chart — Tableau Viz Extension.
 *
 * Marks card tiles (declared in bar-chart.trex):
 *   category   Axis: 0–3 dimensions. One bar per member; outer fields group
 *              the bars. Empty → one bar per measure (Measure Names).
 *   values     Values: the measures the bars show (dropped one by one).
 *   series     Color: optional dimension that splits each category into
 *              coloured bars (grouped, stacked, 100% or left-right).
 *   breakdown  Breakdown: optional dimensions for the tooltip, bar segments
 *              and drill-down (double-click a bar).
 *   line       Line: optional measures drawn as lines over the bars.
 *   target     Target: optional measure drawn as a marker on every bar.
 *   tooltip    Tooltip: optional extra measures for the tooltip.
 *
 * Header (icon, title, explanation) is the same as KPI Card 3; the card
 * options are Waterfall's. Everything else is set in the Format dialog
 * (configure.html), which also opens from the chart's right-click menu.
 */
(function () {
  var el = {};
  var worksheet = null;
  var cfg = null;
  var raw = null; // extracted data, see extract()
  var view = null; // what the last paint drew, see buildView()
  var drawn = []; // hit areas: { node, s, kind, i, v (the view / panel it belongs to) }
  var catRefs = []; // nodes of the names on the axis (data-cat), across panels
  var renderToken = 0;
  var uid = 0;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SEP = '\u0001';

  /** In-memory state (not saved): legend toggles, drill, pinned tooltip. */
  var state = {
    off: {}, // legend items switched off: key → true
    expanded: {}, // drill (expand one): node key → true
    focus: [], // drill (focus): stack of node keys
    level: 0, // drill (expand all): depth
    pinned: null, // drawn item whose tooltip is pinned
    ttSort: null, // pinned tooltip sort override
    animate: true, // grow the bars on the next paint
    hoverKey: null,
    sel: null // node key selected by a click (Click selects the bar in Tableau)
  };

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'drillbar', 'body', 'legend', 'plot', 'svg', 'hint', 'tooltip', 'menu', 'note'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    // on the plot, not the svg: with small multiples every panel has its own svg
    el.plot.addEventListener('mousemove', onHoverEvent);
    el.plot.addEventListener('mouseleave', function () { clearHoverNow(); });
    el.plot.addEventListener('contextmenu', onContextMenu);
    el.plot.addEventListener('click', onClick);
    el.plot.addEventListener('dblclick', onDblClick);
    document.addEventListener('mousedown', function (e) {
      if (!el.menu.contains(e.target)) hideMenu();
      if (state.pinned && !el.tooltip.contains(e.target) && !el.plot.contains(e.target)) unpin();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { hideMenu(); unpin(); closeNote(); }
    });
    window.addEventListener('blur', hideMenu);

    if (window.ExtTiming) ExtTiming.mark('initializeAsync start');
    return tableau.extensions.initializeAsync({ configure: function () { return openDialog(null); } }).then(function () {
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Bc.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, function () { state.animate = true; loadParams(); refresh(); });
      loadParams();
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () {
          // while the dialog's live preview drives the chart, saves (which lag behind it) are ignored
          if (liveActive) return;
          cfg = Bc.read(); paint();
        }
      );
      window.addEventListener('storage', onLiveSettings);

      if (window.ResizeObserver) {
        new ResizeObserver(function () { schedule(); }).observe(document.body);
      } else {
        window.addEventListener('resize', schedule);
      }
      return refresh();
    }).catch(function (err) {
      console.error('Bar Chart failed to initialize:', err);
      showEmpty('Could not initialize the extension. See the console for details.');
    });
  }

  // ---------------------------------------------------------------------------
  // Parameters: for <Parameter> in the title / explanation and measure names
  // ---------------------------------------------------------------------------
  var params = {}; // lower-case name → { name, value }
  var paramWatch = {};
  function loadParams () {
    try {
      if (!worksheet || !worksheet.getParametersAsync) return Promise.resolve();
      return worksheet.getParametersAsync().then(function (list) {
        var next = {};
        (list || []).forEach(function (p) {
          var cv = p.currentValue || {};
          next[String(p.name).toLowerCase()] = { name: p.name, value: cv.formattedValue != null ? String(cv.formattedValue) : String(cv.value) };
          var id = p.id || p.name;
          if (!paramWatch[id] && p.addEventListener && tableau.TableauEventType.ParameterChanged) {
            paramWatch[id] = true;
            p.addEventListener(tableau.TableauEventType.ParameterChanged, function () { loadParams().then(function () { schedule(); }); });
          }
        });
        var changed = JSON.stringify(next) !== JSON.stringify(params);
        params = next;
        if (changed && raw) schedule();
      }).catch(function (e) { console.info('Bar Chart: parameters not available', e && e.message); });
    } catch (e) { return Promise.resolve(); }
  }

  /** Current value of a parameter (name with or without "Parameters."), or null. */
  function paramValue (name) {
    var k = String(name || '').trim().replace(/^\[?parameters\]?\./i, '').replace(/^\[|\]$/g, '').toLowerCase();
    return params[k] ? params[k].value : null;
  }

  /** "<Region Param> by Customer" → "West by Customer". Unknown <…> are left as written. */
  function fillParams (text) {
    return String(text || '').replace(/<([^<>]+)>/g, function (all, nm) {
      var v = paramValue(nm);
      return v != null ? v : all;
    });
  }

  /** Display name of a Measure / Line / Target / Tooltip field: default, custom text or a parameter's value. */
  function nameOf (f, legacy) {
    if (!f) return '';
    var N = cfg && cfg.names ? cfg.names[f.key] : null;
    if (N && N.mode === 'param') { var pv = paramValue(N.param); if (pv != null && pv !== '') return pv; return legacy || f.name; }
    if (N && N.mode === 'custom') return N.text ? fillParams(N.text) : f.name;
    if (N && N.mode === 'default') return f.name;
    return legacy || f.name;
  }
  function measureLabel (m) { return nameOf(m, Bc.seriesCfg(cfg, m.key).label); }
  function lineLabel (l) { return nameOf(l, Bc.lineCfg(cfg, l.key).label); }
  function fieldLabel (x) { return nameOf(x, ''); }

  var queued = false;
  function schedule () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; paint(); });
  }

  /**
   * Opens the Format dialog. `focus` ({ tab, item }) preselects a tab and an
   * item (series / member). The dialog gets the fields and members as
   * payload, because it can't read the worksheet itself.
   */
  // ---------------------------------------------------------------------------
  // Live preview: the Format dialog also writes its settings to localStorage
  // (same origin), so the chart redraws at once instead of waiting for Tableau
  // to save them; the chart sends back what the dialog lists (fields, legend
  // items …) so the dialog stays current. Tableau's save still follows.
  // ---------------------------------------------------------------------------
  var liveId = 'bc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  var liveActive = false;
  var infoTimer = null;
  function onLiveSettings (e) {
    if (e.key !== 'barchart:live:' + liveId || !e.newValue) return;
    try {
      var o = JSON.parse(e.newValue);
      liveActive = true;
      cfg = Bc.merge(Bc.DEFAULTS, o.cfg);
    } catch (err) { return; }
    schedule();
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () {
      try { if (raw) window.localStorage.setItem('barchart:info:' + liveId, JSON.stringify(dialogInfo(null))); } catch (err) { /* ignore */ }
    }, 120);
  }

  function openDialog (focus) {
    hideMenu();
    unpin();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify(dialogInfo(focus));
    var options = { width: 620, height: 780 };
    // On top (Modal) keeps the Format window in front of Tableau until Done; Floating (Modeless) lets you click the workbook but can fall behind it.
    var DS = tableau.DialogStyle || {};
    var style = cfg && cfg.interaction.dialog === 'floating' ? DS.Modeless : DS.Modal;
    if (style) options.dialogStyle = style;
    var done = function () {
      // dialog closed: back to what Tableau saved
      if (!liveActive) return;
      liveActive = false;
      // the dialog may have closed before its last save: the chart has its latest settings, so it saves them
      try {
        if (tableau.extensions.settings.get(Bc.STORAGE_KEY) !== JSON.stringify(cfg)) Bc.write(cfg).catch(function () { /* viewer: can't save */ });
      } catch (e) { /* ignore */ }
      paint();
    };
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).then(done, function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Bar Chart dialog:', err && err.message);
      done();
    });
  }

  /** What the dialog needs to list: series, members, lines, dims, bars with comments. */
  function dialogInfo (focus) {
    var info = { focus: focus || null, liveId: liveId, series: [], members: [], lines: [], dims: [], combos: [], measures: [], bars: [], hasTarget: false, catCount: 0, axisType: 'dimension' };
    if (!raw) return info;
    var v = view || buildView();
    info.series = v.series.map(function (s) { return { key: s.key, name: s.name, color: s.color }; });
    var seen = {};
    v.allNodes.forEach(function (n) { if (!seen[n.label]) { seen[n.label] = 1; info.members.push(n.label); } });
    info.lines = raw.lines.map(function (l) { return { key: l.key, name: l.name }; });
    info.dims = raw.dims.map(function (d) { return { key: d.key, name: d.name }; });
    info.combos = comboList().slice(0, 400);
    info.measures = raw.measures.map(function (m) { return { key: m.key, name: m.name }; });
    info.bars = v.nodes.map(function (n) { return { key: n.key, label: n.label, path: n.pathLabel }; });
    info.hasTarget = !!targetInfo();
    info.extras = raw.extras.map(function (x) { return { key: x.key, name: x.name }; });
    info.levels = (raw.dimFields || []).map(function (f, i) { return { key: f.key, name: f.name, values: (raw.levelValues[i] || []).slice(0, 500) }; });
    info.L = raw.L;
    try {
      info.legendItems = legendItems(v).filter(function (it) { return !it.ramp; }).map(function (it) { return { id: it.id, name: it.orig, long: it.long, short: it.short }; });
    } catch (e) { info.legendItems = []; }
    info.params = Object.keys(params).map(function (k) { return { name: params[k].name, value: params[k].value }; });
    info.target = raw.target ? { key: raw.target.key, name: raw.target.name } : null;
    info.labels = {};
    raw.measures.forEach(function (m) { info.labels[m.key] = measureLabel(m); });
    raw.lines.forEach(function (l) { info.labels[l.key] = lineLabel(l); });
    raw.extras.forEach(function (x) { info.labels[x.key] = fieldLabel(x); });
    if (raw.target) info.labels[raw.target.key] = fieldLabel(raw.target);
    info.seriesIdx = raw.seriesIdx || [];
    info.seriesName = (raw.seriesFields || []).map(function (f) { return f.name; }).join(' · ') || null;
    info.barCandidates = (raw.dimFields || []).filter(function (f, i) { return (raw.seriesIdx || []).indexOf(i) < 0 && (raw.panelIdx || []).indexOf(i) < 0; }).map(function (f) { return f.name; });
    info.catCount = raw.catFields.length;
    info.axisType = v.axisType;
    info.isDate = raw.catIsDate;
    return info;
  }

  // ---------------------------------------------------------------------------
  // Last-render cache (same approach as Waterfall)
  // ---------------------------------------------------------------------------
  var CACHE_PREFIX = 'barchart:lastRender:v2:';
  var CACHE_MAX_AGE = 30 * 24 * 3600 * 1000;
  var CACHE_MAX_CHARS = 400000;
  var cacheTried = false;

  function cacheKey () {
    var host = '';
    try { host = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { /* ignore */ }
    return CACHE_PREFIX + host + '|' + (worksheet && worksheet.name);
  }

  function fieldsSig (fields) {
    var out = {};
    Object.keys(fields).sort().forEach(function (k) {
      out[k] = fields[k].map(function (f) { return (f.id || '') + '|' + (f.name || ''); });
    });
    return JSON.stringify(out);
  }

  function enc (k, v) {
    var r = this[k];
    if (r instanceof Date) return { $d: r.getTime() };
    if (typeof r === 'number' && !isFinite(r)) return { $n: String(r) };
    return v;
  }
  function dec (k, v) {
    if (v && typeof v === 'object') {
      if (Object.prototype.hasOwnProperty.call(v, '$d')) return new Date(v.$d);
      if (Object.prototype.hasOwnProperty.call(v, '$n')) return Number(v.$n);
    }
    return v;
  }

  function readCacheEntry () {
    try {
      var s = window.localStorage.getItem(cacheKey());
      if (!s) return null;
      var c = JSON.parse(s, dec);
      if (!c || !c.data || !(Date.now() - c.t < CACHE_MAX_AGE)) return null;
      return c;
    } catch (e) { return null; }
  }

  function writeCache (fields, data) {
    try {
      var s = JSON.stringify({ sig: fieldsSig(fields), t: Date.now(), data: data }, enc);
      if (s.length > CACHE_MAX_CHARS) return;
      try {
        window.localStorage.setItem(cacheKey(), s);
      } catch (full) {
        for (var i = window.localStorage.length - 1; i >= 0; i--) {
          var k = window.localStorage.key(i);
          if (k && k.indexOf(CACHE_PREFIX) === 0) window.localStorage.removeItem(k);
        }
        window.localStorage.setItem(cacheKey(), s);
      }
    } catch (e) { /* ignore */ }
  }

  function clearCache () {
    try { window.localStorage.removeItem(cacheKey()); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  // Custom tiles (bar-chart.trex: Dimension, Measure, Line, Target) plus
  // Tableau's own Detail and Tooltip tiles, mapped in getEncodedFields().
  var TILES = ['category', 'values', 'line', 'target', 'tooltip', 'detail'];

  async function refresh () {
    if (raw && !raw.rowsAll) raw = null; // cache from an older version
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var t0 = performance.now();
    var first = token === 1;
    var ms = function () { return Math.round(performance.now() - t0); };
    if (first) T.mark('data requested');
    try {
      var tFields = 0;
      var tData = 0;
      var fieldsP = getEncodedFields().then(function (r) { tFields = ms(); if (first) T.mark('fields received (Marks card)'); return r; });
      var dataP = readSummaryData().then(function (r) {
        tData = ms();
        if (first) T.mark('data received', (r && r.data ? r.data.length : 0) + ' rows');
        return r;
      }).catch(function (err) { tData = ms(); return { error: err }; });

      if (!cacheTried) {
        cacheTried = true;
        var entry = readCacheEntry();
        if (entry && !raw) {
          raw = entry.data;
          try { paint(); T.mark('cached result drawn'); } catch (e) { raw = null; entry = null; }
        }
        if (entry) {
          fieldsP.then(function (f) {
            if (token !== renderToken || raw !== entry.data || entry.sig === fieldsSig(f)) return;
            raw = null;
            showEmpty('');
            T.mark('cached result removed (fields changed)');
          }).catch(function () { /* handled below */ });
        }
      }

      var results = await Promise.all([fieldsP, dataP]);
      if (token !== renderToken) return;
      var fields = results[0];

      if (!fields.values.length) {
        raw = null;
        clearCache();
        if (first) { T.mark('no measure on Measure'); T.done('Bar Chart load timings'); }
        showEmpty('Drag a measure onto <b>Measure</b> and a dimension onto <b>Dimension</b>.<br>' +
          'More Dimension fields become the breakdown and drill-down levels. Optional: <b>Line</b> draws a line over the bars, ' +
          '<b>Target</b> adds a marker to every bar, and any field on Tableau\'s <b>Tooltip</b> tile adds a tooltip row.');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      var prevSig = raw && raw.sig;
      raw = extract(table, fields);
      raw.sig = fieldsSig(fields);
      if (prevSig && prevSig !== raw.sig) { state.expanded = {}; state.focus = []; state.level = 0; state.off = {}; }
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Bar Chart load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
      // saving the last render can take a while on big data: do it when the browser is idle
      var toSave = raw;
      (window.requestIdleCallback || function (f) { return setTimeout(f, 800); })(function () { if (raw === toSave) writeCache(fields, toSave); }, { timeout: 4000 });
    } catch (err) {
      console.error('Bar Chart render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Bar Chart load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. See the console for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = {};
    TILES.forEach(function (t) { fields[t] = []; });
    marks.encodings.forEach(function (e) {
      if (!e.field) return;
      var type = String(e.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : e.id;
      // Detail and Tooltip are Tableau's own tiles. Everything on Tooltip (dimension or
      // measure, discrete or continuous) becomes a "name: value" tooltip row, in tile
      // order; measures on Detail too. Dimensions on Detail only add rows.
      if (id === 'tooltip') id = 'tooltip';
      else if (id === 'detail') id = isMeasureField(e.field) ? 'tooltip' : 'detail';
      (fields[id] = fields[id] || []).push(e.field);
    });
    return fields;
  }

  function isMeasureField (f) {
    var role = String(f.role || '').toLowerCase();
    if (role === 'measure') return true;
    if (role === 'dimension') return false;
    return /^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|STDEV|STDEVP|VAR|VARP|PCT\d+)\(/i.test(String(f.name || ''));
  }

  async function readSummaryData () {
    var reader = await worksheet.getSummaryDataReaderAsync(undefined, { ignoreSelection: true });
    try {
      return await reader.getAllPagesAsync();
    } finally {
      await reader.releaseAsync();
    }
  }

  function norm (s) {
    return String(s || '').replace(/^[A-Z_]+\((.*)\)$/i, '$1').trim().toLowerCase();
  }

  function nameParts (s) {
    var str = String(s || '');
    var i = str.indexOf('//');
    if (i < 0) return [norm(str)];
    return [norm(str.slice(i + 2)), norm(str.slice(0, i))].filter(Boolean);
  }

  function isMN (c) { return /^measure (names|values)$/i.test(c.fieldName); }
  function isNumericCol (c) { return /^(float|int|real|integer|number)$/i.test(String(c.dataType || '')); }
  function isDateCol (c) { return /date/i.test(String(c.dataType || '')); }

  function findColumn (table, field, taken) {
    if (!field) return null;
    var cols = table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    var fid = field.id || field.fieldId;
    var fn = nameParts(field.name);
    return cols.find(function (c) { return fid && c.fieldId && c.fieldId === fid; }) ||
      cols.find(function (c) { return c.fieldName === field.name; }) ||
      cols.find(function (c) { return norm(c.fieldName) === norm(field.name); }) ||
      cols.find(function (c) {
        var cn = nameParts(c.fieldName);
        return cn.some(function (x) { return fn.indexOf(x) >= 0; });
      }) ||
      null;
  }

  /** Renamed pills: unmatched fields take the free columns in order (see Waterfall). */
  function matchLeftovers (table, reqs, taken, pivoted) {
    var free = function () {
      return table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    };
    var take = function (r, c) { if (c) { r.col = c; taken.push(c); r.guessed = true; } };
    reqs.forEach(function (r) {
      if (!r.col && r.dim) take(r, free().find(function (x) { return !isNumericCol(x); }));
    });
    if (!pivoted) {
      reqs.forEach(function (r) {
        if (!r.col && !r.dim) take(r, free().find(isNumericCol));
      });
    }
    reqs.forEach(function (r) {
      if (!r.col && (r.dim || !pivoted)) take(r, free()[0]);
    });
    var guessed = reqs.filter(function (r) { return r.guessed; });
    if (guessed.length) {
      console.info('Bar Chart: matched renamed fields by position:', guessed.map(function (r) {
        return (r.field && r.field.name) + ' → ' + r.col.fieldName;
      }));
    }
  }

  function toNumber (cell) {
    if (!cell) return NaN;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v === null || v === '%null%' || v === '') return NaN;
    return typeof v === 'number' ? v : Number(v);
  }

  var DATE_PARTS = { YEAR: 'Year', QUARTER: 'Quarter', MONTH: 'Month', WEEK: 'Week', DAY: 'Day', WEEKDAY: 'Weekday', HOUR: 'Hour',
    TYR: 'Year', TQR: 'Quarter', TMN: 'Month', TWK: 'Week', TDY: 'Day', MY: 'Month', QY: 'Quarter', MDY: 'Day' };

  function cleanName (name) {
    var s = String(name || '');
    var m = /^([A-Z]+)\((.*)\)$/i.exec(s);
    if (m && DATE_PARTS[m[1].toUpperCase()]) return DATE_PARTS[m[1].toUpperCase()] + ' of ' + m[2];
    return s.replace(/^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|ATTR|STDEV|VAR)\((.*)\)$/i, '$2');
  }

  function cellText (cell) {
    if (!cell) return '';
    var f = cell.formattedValue;
    if (f == null || f === '%null%') f = cell.value;
    return f == null || f === '%null%' ? 'Null' : String(f);
  }

  /**
   * Summary data → rows with every tile's values:
   *   { d: [Dimension tile values], dd: [date ms per level | null], v: { measure: n },
   *     fv: { measure: Tableau text }, l: { line: n }, t: target, x: { tooltip measure: n } }
   * Which Dimension fields make the bars and which are the breakdown is
   * decided per paint (prepareRows), so it can change in the Format dialog.
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var cMN = table.columns.find(function (c) { return /^measure names$/i.test(c.fieldName); });
    var cMV = table.columns.find(function (c) { return /^measure values$/i.test(c.fieldName); });

    function dimReq (f) { return { field: f, dim: true, col: null, key: f.name, name: cleanName(f.name) }; }
    var used = {};
    function measReq (f, kind) {
      var key = f.name;
      while (used[kind + key]) key += '+';
      used[kind + key] = 1;
      return { field: f, dim: false, col: null, key: key, name: cleanName(f.name), kind: kind };
    }
    var cats = fields.category.map(dimReq);
    var meas = fields.values.map(function (f) { return measReq(f, 'v'); });
    var lines = fields.line.map(function (f) { return measReq(f, 'l'); });
    var target = fields.target.map(function (f) { return measReq(f, 't'); });
    var extras = fields.tooltip.map(function (f) {
      if (isMeasureField(f)) return measReq(f, 'x');
      var r = dimReq(f);
      r.kind = 'xd';
      while (used['xd' + r.key]) r.key += '+';
      used['xd' + r.key] = 1;
      return r;
    });
    var details = (fields.detail || []).map(dimReq);

    var reqs = cats.concat(details, meas, lines, target, extras);
    reqs.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    // The same field on two tiles (e.g. Sales on Measure and Line, Region on Dimension and
    // Tooltip) comes as one column: every tile that uses it reads that column.
    reqs.forEach(function (r) {
      if (r.col) return;
      var same = reqs.find(function (o) { return o !== r && o.col && o.field && r.field && (o.field.id && o.field.id === r.field.id || o.field.name === r.field.name); });
      if (same) r.col = same.col;
    });
    matchLeftovers(table, reqs, taken, !!(cMN && cMV));

    var isDate = cats.map(function (r) { return !!r.col && isDateCol(r.col); });

    function cellOf (row, r, mn) {
      if (r.col) return row[r.col.index];
      if (cMN && cMV && (mn === norm(r.field.name) || mn === norm(r.name))) return row[cMV.index];
      return null;
    }

    var out = [];
    var dateCache = {}; // the same axis values repeat on many rows
    rows.forEach(function (row) {
      var mn = cMN ? norm(row[cMN.index].formattedValue || row[cMN.index].value) : null;
      var o = { d: [], dd: [], v: {}, fv: {}, l: {}, t: NaN, x: {}, xt: {}, xf: {} };
      cats.forEach(function (r, i) {
        var cell = r.col ? row[r.col.index] : null;
        o.d.push(cellText(cell));
        var dt = null;
        if (cell) {
          var nv = cell.nativeValue != null ? cell.nativeValue : cell.value;
          var dkey = nv instanceof Date ? null : (isDate[i] ? nv : cellText(cell)) + '';
          if (dkey != null && dkey in dateCache) dt = dateCache[dkey];
          else {
            var pd = Bc.parseDate(nv instanceof Date ? nv : (isDate[i] ? nv : cellText(cell)));
            dt = pd ? pd.getTime() : null;
            if (dkey != null) dateCache[dkey] = dt;
          }
        }
        o.dd.push(dt);
      });
      var any = false;
      meas.forEach(function (r) {
        var cell = cellOf(row, r, mn);
        if (!cell) return;
        var n = toNumber(cell);
        if (!isFinite(n)) return;
        o.v[r.key] = n; o.fv[r.key] = cell.formattedValue; any = true;
      });
      lines.forEach(function (r) { var c = cellOf(row, r, mn); var n = toNumber(c); if (isFinite(n)) { o.l[r.key] = n; any = true; } });
      target.forEach(function (r) { var c = cellOf(row, r, mn); var n = toNumber(c); if (isFinite(n)) { o.t = n; any = true; } });
      extras.forEach(function (r) {
        var c = cellOf(row, r, mn);
        if (r.dim) { if (c) o.xt[r.key] = cellText(c); return; }
        var n = toNumber(c);
        if (isFinite(n)) { o.x[r.key] = n; if (c.formattedValue != null) o.xf[r.key] = String(c.formattedValue); any = true; }
        else if (c && cellText(c) !== 'Null') o.xt[r.key] = cellText(c); // e.g. ATTR of a text field
      });
      if (any || !cMN) out.push(o);
    });

    var strip = function (r) { return { key: r.key, name: r.name }; };
    return {
      rowsAll: out,
      dimFields: cats.map(function (r, i) { return { key: r.key, name: r.name, isDate: isDate[i] }; }),
      measures: meas.map(strip),
      lines: lines.map(strip),
      target: target[0] ? strip(target[0]) : null,
      extras: extras.map(function (r) { var o = strip(r); if (r.dim) o.dim = true; return o; }),
      // filled per paint by prepareRows()
      rows: [], catFields: [], dims: [], catIsDate: false, seriesIdx: [], seriesFields: [], barIdx: [], dimPos: []
    };
  }

  /** The Target tile's measure. */
  function targetInfo () {
    return raw ? raw.target : null;
  }

  /** Distinct breakdown combinations in data order (for the dialog's colour lists). */
  function comboList () {
    var seen = {};
    var out = [];
    raw.rows.forEach(function (r) {
      var b = raw.dimPos.map(function (i) { return r.d[i]; });
      var k = b.join(SEP);
      if (b.length && !seen[k]) { seen[k] = 1; out.push(b); }
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // View: series, categories (nodes), drill, Top N, sorting, groups, colours
  // ---------------------------------------------------------------------------
  var SS = '\u0002'; // measure ↔ member in a series key
  var CS = '\u0003'; // parent ↔ child in a drilled node key

  function axisTypeOf () {
    var t = cfg.chart.axisType;
    if (t === 'measureNames') return 'measureNames';
    if (!raw.catFields.length) return raw.seriesIdx && raw.seriesIdx.length ? 'dimension' : 'measureNames'; // all fields split: one bar
    if (t === 'date') return 'date';
    if (t === 'dimension') return 'dimension';
    return raw.catIsDate || raw.rows.some(function (r) { return r.cd != null; }) && looksLikeDates() ? 'date' : 'dimension';
  }

  /** Every innermost axis value parses as a date (and they aren't plain small numbers). */
  function looksLikeDates () {
    if (!raw.rows.length) return false;
    return raw.rows.every(function (r) {
      var t = r.c[r.c.length - 1];
      return r.cd != null && !/^\d{1,3}$/.test(t);
    });
  }

  // ---------------------------------------------------------------------------
  // Rows for this paint: which Dimension fields make the bars (the rest is the
  // breakdown), legend filters, and Top N with Others at the chosen level.
  // ---------------------------------------------------------------------------
  /**
   * Dimension fields whose values (combined, e.g. "West · Consumer") become the
   * series — stacked, 100%, overlapping, left-right, side by side — instead of
   * the measures, like dimensions on Tableau's Color. Absolute indices into
   * raw.dimFields; [] = the measures are the series.
   *   seriesBy 'dims'  the fields in chart.seriesDims (any fields, in that order)
   *   seriesBy 'dim'   (older workbooks) the last field
   *   seriesBy 'auto'  the last field when there is one measure and the layout isn't regular
   *   seriesBy 'all'   every Dimension field: one bar split by all of them (works on any sheet, for presets)
   */
  function seriesFields () {
    var F = raw.dimFields || [];
    var P = panelFields();
    var free = F.map(function (f, i) { return i; }).filter(function (i) { return P.indexOf(i) < 0; }); // panel fields don't split bars
    var m = cfg.chart.seriesBy;
    if (!free.length || m === 'measures' || cfg.chart.axisType === 'measureNames') return [];
    if (m === 'all') return free;
    if (m === 'dims') {
      var keys = F.map(function (f) { return f.key; });
      var out = [];
      (cfg.chart.seriesDims || []).forEach(function (k) { var i = keys.indexOf(k); if (i >= 0 && out.indexOf(i) < 0 && P.indexOf(i) < 0) out.push(i); });
      return out;
    }
    if (free.length < 2) return [];
    var lastFree = free[free.length - 1];
    if (m === 'dim') return [lastFree];
    return raw.measures.length === 1 && cfg.chart.layout !== 'regular' ? [lastFree] : [];
  }

  /**
   * Dimension fields that split the chart into panels (small multiples), like
   * dimensions on Tableau's Rows or Columns: one chart per value (combined when
   * several), in tile order. Absolute indices into raw.dimFields.
   */
  function panelFields () {
    var F = raw.dimFields || [];
    if (!F.length) return [];
    var keys = F.map(function (f) { return f.key; });
    var out = [];
    (cfg.chart.panelDims || []).forEach(function (k) { var i = keys.indexOf(k); if (i >= 0 && out.indexOf(i) < 0) out.push(i); });
    return out.sort(function (a, b) { return a - b; });
  }

  /** One panel per measure (Measure Names on Rows / Columns): needs 2+ measures, and measures not on the axis. */
  function measurePanels () {
    return !!cfg.chart.panelMeasures && raw.measures.length > 1 && cfg.chart.axisType !== 'measureNames';
  }

  /** Measures in the view being built: one with a measure panel, else all. */
  var onlyM = null;
  function viewMeasures () { return onlyM ? [onlyM] : raw.measures; }

  function isSeriesField (k) { return !!raw.seriesIdx && raw.seriesIdx.indexOf(k) >= 0; }

  function prepareRows () {
    var F = raw.dimFields || [];
    var P = panelFields();
    var S = seriesFields();
    // fields left for the bars and the breakdown, in tile order
    var NS = F.map(function (f, i) { return i; }).filter(function (i) { return S.indexOf(i) < 0 && P.indexOf(i) < 0; });
    raw.panelIdx = P;
    raw.panelFields = P.map(function (i) { return F[i]; });
    var L = !NS.length ? 0 : cfg.chart.showAll ? NS.length : Math.max(1, Math.min(NS.length, Math.round(Number(cfg.chart.barLevel)) || 1));
    var barIdx = NS.slice(0, L);
    raw.L = L;
    raw.barIdx = barIdx;
    raw.dimPos = NS.slice(L); // absolute index of each breakdown field
    raw.seriesIdx = S;
    raw.catFields = barIdx.map(function (i) { return F[i]; });
    raw.dims = raw.dimPos.map(function (i) { return F[i]; });
    raw.catIsDate = L ? !!F[barIdx[L - 1]].isDate : false;
    raw.seriesFields = S.map(function (i) { return F[i]; });
    // distinct values per Dimension field, in data order
    raw.levelValues = F.map(function () { return []; });
    var seen = F.map(function () { return {}; });
    raw.rowsAll.forEach(function (r) {
      r.d.forEach(function (x, i) { if (!seen[i][x]) { seen[i][x] = 1; raw.levelValues[i].push(x); } });
    });
    // legend: dimension values switched off
    var off = Object.keys(state.off).filter(function (k) { return k.indexOf('d:') === 0 && state.off[k]; }).map(function (k) {
      var i = k.indexOf('|');
      return { k: Number(k.slice(2, i)), v: k.slice(i + 1) };
    });
    var rows = off.length ? raw.rowsAll.filter(function (r) { return !off.some(function (o) { return r.d[o.k] === o.v; }); }) : raw.rowsAll;
    rows = topNRows(rows, L);
    var last = L ? barIdx[L - 1] : -1;
    raw.rows = rows.map(function (r) {
      return { c: barIdx.map(function (i) { return r.d[i]; }), b: r.d, sm: S.length ? S.map(function (i) { return r.d[i]; }).join(' \u00b7 ') : null, pm: P.length ? P.map(function (i) { return r.d[i]; }).join(' \u00b7 ') : null, cd: last >= 0 ? r.dd[last] : null, d: r.d, v: r.v, fv: r.fv, l: r.l, t: r.t, x: r.x, xt: r.xt || {}, xf: r.xf || {}, oth: !!r.oth };
    });
  }

  function topNLevel (L) {
    var T = cfg.topN;
    var F = raw.dimFields || [];
    if (T.level === 'auto' || T.level === '' || T.level == null) return L ? raw.barIdx[L - 1] : 0;
    return Math.max(0, Math.min(F.length - 1, Number(T.level) || 0));
  }

  /**
   * Top N per parent at one Dimension level, ranked by one measure (or the
   * total of all), e.g. the top 3 products in each category by Sales. The rest
   * becomes one "Others" member (or is left out).
   */
  function topNRows (rows, L) {
    var T = cfg.topN;
    var F = raw.dimFields || [];
    if (!T.enabled || !F.length || !(T.n > 0)) return rows;
    var k = topNLevel(L);
    var val = function (r) {
      if (T.by && T.by !== '__total') return Number(r.v[T.by]) || 0;
      return Object.keys(r.v).reduce(function (a, m) { return a + r.v[m]; }, 0);
    };
    // within each parent (e.g. top 3 Sub-Categories in every Category) or across all of them
    var parentOf = T.scope === 'overall' ? function () { return ''; } : function (r) { return r.d.slice(0, k).join(SEP); };
    var groups = {};
    rows.forEach(function (r) {
      var p = parentOf(r);
      var g = groups[p] || (groups[p] = {});
      g[r.d[k]] = (g[r.d[k]] || 0) + val(r);
    });
    var keep = {};
    var rest = {};
    Object.keys(groups).forEach(function (p) {
      var g = groups[p];
      var names = Object.keys(g).sort(function (a, b) { return T.direction === 'bottom' ? g[a] - g[b] : g[b] - g[a]; });
      keep[p] = {};
      names.slice(0, T.n).forEach(function (n) { keep[p][n] = 1; });
      rest[p] = Math.max(0, names.length - T.n);
    });
    // for averages: how many members went into each parent's Others bar
    var restIn = {};
    var seenRest = {};
    rows.forEach(function (r) {
      var p = parentOf(r);
      if (keep[p][r.d[k]]) return;
      var pp = r.d.slice(0, k).join(SEP);
      var key = pp + SEP + r.d[k];
      if (!seenRest[key]) { seenRest[key] = 1; restIn[pp] = (restIn[pp] || 0) + 1; }
    });
    var label = T.label || 'Others';
    var out = [];
    rows.forEach(function (r) {
      var p = parentOf(r);
      if (keep[p][r.d[k]]) { out.push(r); return; }
      if (!T.others) return;
      var c = { d: r.d.slice(), dd: r.dd.slice(), v: {}, fv: {}, l: {}, x: {}, xt: r.xt || {}, t: r.t, oth: true };
      for (var j = k; j < c.d.length; j++) { if (j > k && (isSeriesField(j) || raw.panelIdx.indexOf(j) >= 0)) continue; c.d[j] = label; c.dd[j] = null; }
      var div = T.othersAgg === 'avg' ? (restIn[r.d.slice(0, k).join(SEP)] || 1) : 1;
      Object.keys(r.v).forEach(function (m) { c.v[m] = r.v[m] / div; });
      Object.keys(r.l).forEach(function (m) { c.l[m] = r.l[m] / div; });
      Object.keys(r.x).forEach(function (m) { c.x[m] = r.x[m] / div; });
      if (isFinite(c.t)) c.t /= div;
      out.push(c);
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Members: what "each bar" is for colours, highlights, icons and groups.
  //   'auto'      the bar's own name
  //   'measures'  the measure name (Measure tile)
  //   'dim:k'     the value of Dimension field k
  // ---------------------------------------------------------------------------
  function memberOf (n, b, src) {
    if (!src || src === 'auto') return n.label;
    if (src === 'measures') return n.measureName || (b && b.s && b.s.measureName) || (raw.measures.length === 1 ? raw.measures[0].name : null);
    if (src.indexOf('dim:') === 0) {
      var k = Number(src.slice(4));
      if (isSeriesField(k) && b && b.s && b.s.member != null) return raw.seriesIdx.length === 1 ? b.s.member : b.s.parts[raw.seriesIdx.indexOf(k)];
      return n.dimPath && n.dimPath[k] != null ? n.dimPath[k] : null;
    }
    return n.label;
  }

  /** Dimension level deeper than this bar (its values split the bar into segments), or -1. */
  function deeperLevel (n, src) {
    if (!src || src.indexOf('dim:') !== 0) return -1;
    var k = Number(src.slice(4));
    // a breakdown field this bar isn't split by yet
    if (raw.dimPos.indexOf(k) < 0 || (n.dimPath && n.dimPath[k] != null)) return -1;
    return k;
  }

  function palette () { return Bc.paletteColors(cfg.colors.palette, cfg.colors.paletteEdits); }

  function measureIndex (key) { return raw.measures.findIndex(function (m) { return m.key === key; }); }

  function measureColor (key) {
    var i = measureIndex(key);
    var sc = Bc.seriesCfg(cfg, key);
    if (sc.color && Bc.normalizeHex(sc.color)) return sc.color;
    var pal = palette();
    return pal[(i < 0 ? 0 : i) % pal.length];
  }

  function measureKeyByName (name) {
    var m = raw.measures.find(function (x) { return x.name === name; });
    return m ? m.key : null;
  }

  function dimLevelOf () {
    var lv = cfg.colors.dimLevel;
    if (lv === 'auto' || lv === '' || lv == null) return raw.L ? raw.barIdx[raw.L - 1] : 0;
    return Math.max(0, Math.min((raw.dimFields || []).length - 1, Number(lv) || 0));
  }

  function dimColor (k, value) {
    var C = cfg.colors;
    var c = C.custom[k + '|' + value] || C.custom[value];
    if (c && Bc.normalizeHex(c)) return c;
    var pal = palette();
    var i = raw.levelValues && raw.levelValues[k] ? raw.levelValues[k].indexOf(value) : -1;
    return pal[(i < 0 ? 0 : i) % pal.length];
  }

  /** Colour source that splits bars into segments (Dimensions or Highlight at a deeper level). */
  function colorSegSource () {
    var m = view && view.cmode ? view.cmode : colorMode(raw.measures.length);
    if (m === 'dimensions') return 'dim:' + dimLevelOf();
    if (m === 'highlight') return cfg.colors.highlightBy || 'auto';
    return null;
  }

  function seriesDefs (axisType) {
    var M = viewMeasures();
    var defs = [];
    if (raw.seriesIdx.length && axisType !== 'measureNames') return dimSeriesDefs();
    if (axisType === 'measureNames' || M.length <= 1) {
      var one = M.length === 1 && axisType !== 'measureNames' ? M[0] : null;
      defs.push({ key: one ? one.key : '__v', name: one ? one.name : (M.length === 1 ? M[0].name : 'Value'), measure: one ? one.key : null, measureName: one ? one.name : null });
    } else {
      M.forEach(function (m) { defs.push({ key: m.key, name: m.name, measure: m.key, measureName: m.name }); });
    }
    defs.forEach(function (d, i) {
      var sc = Bc.seriesCfg(cfg, d.key);
      d.idx = i;
      var mm = d.measure ? M.find(function (m) { return m.key === d.measure; }) : (M.length === 1 ? M[0] : null);
      if (mm) d.name = measureLabel(mm);
      else if (sc.label) d.name = sc.label;
      d.color = d.measure ? measureColor(d.measure) : cfg.colors.single;
    });
    return defs;
  }

  /** Series from the values of a Dimension field (per measure when there are several). */
  function dimSeriesDefs () {
    var M = viewMeasures();
    var S = raw.seriesIdx;
    var one = S.length === 1;
    var oth = cfg.topN.label || 'Others';
    var seen = {};
    var mem = [];
    raw.rows.forEach(function (r) { if (r.sm != null && !seen[r.sm]) { seen[r.sm] = 1; mem.push(r.sm); } });
    var order = one ? (raw.levelValues[S[0]] || []).filter(function (x) { return seen[x]; }) : [];
    mem.forEach(function (x) { if (order.indexOf(x) < 0) order.push(x); });
    var isOth = function (x) { return raw.rows.some(function (r) { return r.oth && r.sm === x && String(x).split(' \u00b7 ').indexOf(oth) >= 0; }); };
    var othList = order.filter(isOth);
    order = order.filter(function (x) { return othList.indexOf(x) < 0; }).concat(othList);
    var pal = palette();
    var defs = [];
    M.forEach(function (m) {
      order.forEach(function (x) {
        defs.push({ key: m.key + SS + x, name: M.length > 1 ? measureLabel(m) + ' \u00b7 ' + x : x, measure: m.key, measureName: m.name,
          member: x, parts: String(x).split(' \u00b7 '), memberOthers: othList.indexOf(x) >= 0 });
      });
    });
    defs.forEach(function (d, i) {
      var sc = Bc.seriesCfg(cfg, d.key);
      d.idx = i;
      if (sc.label) d.name = sc.label;
      var custom = cfg.colors.custom['s|' + d.member];
      d.color = sc.color && Bc.normalizeHex(sc.color) ? sc.color : d.memberOthers ? cfg.topN.color
        : one ? dimColor(S[0], d.member) : custom && Bc.normalizeHex(custom) ? custom : pal[order.indexOf(d.member) % pal.length];
    });
    return defs;
  }

  function colorMode (nSeries) {
    var m = cfg.colors.mode;
    if (m === 'series') m = 'measures';
    if (m === 'category') m = 'dimensions';
    if (m === 'value') m = 'auto'; // "Gradient by value" was removed
    if (m === 'auto') m = nSeries > 1 ? 'measures' : 'single';
    if (m === 'dimensions' && !(raw.dimFields || []).length) m = 'measures';
    return m;
  }

  /** Series key for one measure value. */
  function seriesKeyOf (axisType, mKey, r) {
    if (axisType === 'measureNames') return '__v';
    if (raw.seriesIdx.length && r) return mKey + SS + r.sm;
    return mKey;
  }

  function dateLabel (text, ms) {
    var f = cfg.axisC.dateFormat;
    if (!f || f === 'auto' || ms == null) return text;
    return Bc.formatDate(new Date(ms), f) || text;
  }

  /** Values of the given fields at their own index (others null), so dimPath[k] is field k's value. */
  function positional (d, idx) {
    var out = [];
    var max = idx.length ? Math.max.apply(null, idx) : -1;
    for (var i = 0; i <= max; i++) out.push(idx.indexOf(i) >= 0 ? d[i] : null);
    return out;
  }

  function newNode (key, path, label) {
    return { key: key, path: path, label: label, depth: 0, parent: null, items: [], ris: [], riSeen: {}, date: null, isOthers: false };
  }

  /** Base nodes (one per axis path) from the rows. */
  function baseNodes (axisType, panel, panelKey) {
    var map = {};
    var list = [];
    var nullZero = cfg.numbers.nullAs === 'zero';
    var mkeys = viewMeasures().map(function (m) { return m.key; });
    raw.rows.forEach(function (r, ri) {
      if (panel != null && r.pm !== panel) return; // one panel of small multiples
      mkeys.forEach(function (mk) {
        var has = mk in r.v;
        if (!has && !nullZero) return;
        var path = r.c.slice();
        if (axisType === 'measureNames') path.push(raw.measures.find(function (m) { return m.key === mk; }).name);
        var single = !path.length; // every Dimension field splits the bars: one bar
        if (single) path = ['All'];
        var key = path.join(SEP);
        var n = map[key];
        if (!n) {
          var last = path[path.length - 1];
          n = map[key] = newNode(key, path, single ? viewMeasures().map(measureLabel).join(' & ') : axisType === 'date' ? dateLabel(last, r.cd) : axisType === 'measureNames' ? measureLabel(raw.measures.find(function (m) { return m.key === mk; })) : last);
          n.date = axisType === 'date' ? r.cd : null;
          n.outer = path.slice(0, -1);
          n.dimPath = positional(r.d, raw.barIdx);
          n.panel = panelKey != null ? panelKey : r.pm; // small multiples: the panel this bar is in
          n.panelVals = raw.panelIdx.map(function (i) { return { field: raw.dimFields[i], value: r.d[i] }; });
          if (axisType === 'measureNames') { n.measureName = last; n.measureKey = mk; }
          n.isOthers = !!r.oth && last === (cfg.topN.label || 'Others');
          list.push(n);
        }
        n.items.push({ s: seriesKeyOf(axisType, mk, r), m: mk, sm: r.sm, v: has ? r.v[mk] : 0, fv: r.fv[mk], b: r.b, ri: ri });
        if (!n.riSeen[ri]) { n.riSeen[ri] = 1; n.ris.push(ri); }
      });
    });
    list.forEach(finalize);
    return list;
  }

  /** Sums per series, lines, target and extras of a node. */
  function finalize (n) {
    n.vals = {};
    n.mv = {};
    n.total = 0;
    n.items.forEach(function (it) {
      if (it.m) n.mv[it.m] = (n.mv[it.m] || 0) + it.v;
      var o = n.vals[it.s] || (n.vals[it.s] = { v: 0, n: 0, fv: null });
      o.v += it.v; o.n++; o.fv = o.n === 1 ? it.fv : null;
      n.total += it.v;
    });
    n.l = {}; n.x = {}; n.xt = {}; n.xf = {}; n.t = NaN;
    var tg = targetInfo();
    var tk = tg && !raw.target ? tg.key : null;
    n.ris.forEach(function (ri) {
      var r = raw.rows[ri];
      Object.keys(r.l).forEach(function (k) { n.l[k] = (n.l[k] || 0) + r.l[k]; });
      Object.keys(r.x).forEach(function (k) { n.x[k] = (n.x[k] || 0) + r.x[k]; });
      Object.keys(r.xt || {}).forEach(function (k) { var a = n.xt[k] || (n.xt[k] = []); if (a.indexOf(r.xt[k]) < 0) a.push(r.xt[k]); });
      Object.keys(r.xf || {}).forEach(function (k) { n.xf[k] = n.xf[k] === undefined ? r.xf[k] : null; }); // Tableau's text only for a single row
      var tv = tk ? r.x[tk] : r.t;
      if (isFinite(tv)) n.t = (isFinite(n.t) ? n.t : 0) + tv;
    });
    n.pathLabel = (n.parent ? n.parent.pathLabel + ' › ' : n.outer && n.outer.length ? n.outer.join(' · ') + ' › ' : '') + n.label;
    delete n.riSeen;
    return n;
  }

  /** Drill children of a node: its items split by the next breakdown field. */
  function childrenOf (n) {
    var d = n.depth;
    if (d >= raw.dims.length) return [];
    if (n._kids) return n._kids;
    var map = {};
    var list = [];
    n.items.forEach(function (it) {
      var m = it.b[raw.dimPos[d]];
      var c = map[m];
      if (!c) {
        c = map[m] = newNode(n.key + CS + m, n.path.concat([m]), m);
        c.depth = d + 1; c.parent = n; c.outer = []; c.date = n.date;
        c.dimPath = (n.dimPath || []).slice(); while (c.dimPath.length <= raw.dimPos[d]) c.dimPath.push(null); c.dimPath[raw.dimPos[d]] = m;
        c.panel = n.panel; c.panelVals = n.panelVals;
        c.measureName = n.measureName; c.measureKey = n.measureKey;
        c.isOthers = !!raw.rows[it.ri].oth && m === (cfg.topN.label || 'Others');
        list.push(c);
      }
      c.items.push(it);
      if (!c.riSeen[it.ri]) { c.riSeen[it.ri] = 1; c.ris.push(it.ri); }
    });
    list.forEach(finalize);
    n._kids = sortNodes(list, false);
    return n._kids;
  }

  function sortValue (n) {
    var by = cfg.axisC.sortBy;
    if (by && by !== '__total' && n.vals[by]) return n.vals[by].v;
    if (by && by !== '__total' && n.mv && n.mv[by] != null) return n.mv[by];
    return n.total;
  }

  /**
   * Sorts nodes. With nested Axis fields the bars are sorted inside their
   * outer group and the groups keep together (ordered the same way).
   */
  function sortNodes (list, grouped) {
    var o = cfg.axisC.sort;
    var cmp;
    if (o === 'date' || o === 'dateDesc') {
      var dir = o === 'date' ? 1 : -1;
      cmp = function (a, b) {
        if (a.date == null || b.date == null) return 0;
        return (a.date - b.date) * dir;
      };
    } else {
      cmp = Bc.comparer(o, sortValue, function (n) { return n.label; });
    }
    var oLast = cfg.topN.othersLast;
    var isOth = function (n) { return oLast && n.isOthers; };
    var sortIn = function (items) {
      var rest = items.filter(function (n) { return !isOth(n); });
      return (cmp ? Bc.sortBy(rest, cmp) : rest).concat(items.filter(isOth));
    };
    if (!grouped) return sortIn(list);
    var oLabel = cfg.topN.label || 'Others';
    var groups = [];
    var byKey = {};
    list.forEach(function (n) {
      var k = (n.outer || []).join(SEP);
      if (!byKey[k]) {
        byKey[k] = { key: k, label: (n.outer || []).join(' '), items: [], total: 0, date: n.date, oth: oLast && (n.outer || []).indexOf(oLabel) >= 0 };
        groups.push(byKey[k]);
      }
      byKey[k].items.push(n);
      byKey[k].total += sortValue(n);
    });
    var gcmp = o === 'date' || o === 'dateDesc' ? cmp : Bc.comparer(o, function (g) { return g.total; }, function (g) { return g.label; });
    var gs = groups.filter(function (g) { return !g.oth; });
    gs = gcmp ? Bc.sortBy(gs, gcmp) : gs;
    // an Others group goes after the last group of its own parent (e.g. Chairs › Others after Chairs › West)
    groups.filter(function (g) { return g.oth; }).forEach(function (g) {
      var outer = g.items[0].outer || [];
      var pre = outer.slice(0, outer.indexOf(oLabel)).join(SEP);
      var at = -1;
      gs.forEach(function (x, i) { var xo = (x.items[0].outer || []).join(SEP); if (!pre || xo === pre || xo.indexOf(pre + SEP) === 0) at = i; });
      if (at < 0) gs.push(g); else gs.splice(at + 1, 0, g);
    });
    var out = [];
    gs.forEach(function (g) { out = out.concat(sortIn(g.items)); });
    return out;
  }

  /** Top N by total (or one series) — the rest become "Others" or are left out. */
  function applyTopN (list) {
    var T = cfg.topN;
    if (!T.enabled || !(T.n > 0) || list.length <= T.n) return list;
    var val = function (n) { return T.by && T.by !== '__total' && n.vals[T.by] ? n.vals[T.by].v : n.total; };
    var ranked = Bc.sortBy(list, function (a, b) { return T.direction === 'bottom' ? val(a) - val(b) : val(b) - val(a); });
    var keep = ranked.slice(0, T.n);
    var keepSet = {};
    keep.forEach(function (n) { keepSet[n.key] = 1; });
    var rest = ranked.slice(T.n);
    var out = list.filter(function (n) { return keepSet[n.key]; });
    if (T.others && rest.length) {
      var o = newNode('__others', [T.label || 'Others'], T.label || 'Others');
      o.isOthers = true;
      o.outer = [];
      o.members = rest.map(function (n) { return n.label; });
      rest.forEach(function (n) {
        n.items.forEach(function (it) { o.items.push(it); });
        n.ris.forEach(function (ri) { if (!o.riSeen[ri]) { o.riSeen[ri] = 1; o.ris.push(ri); } });
      });
      finalize(o);
      if (T.othersAgg === 'avg') {
        var k = rest.length;
        o.items = o.items.map(function (it) { var c = Object.assign({}, it); c.v = it.v / k; return c; });
        Object.keys(o.vals).forEach(function (s) { o.vals[s].v /= k; });
        o.total /= k;
        Object.keys(o.l).forEach(function (s) { o.l[s] /= k; });
        Object.keys(o.x).forEach(function (s) { o.x[s] /= k; });
        if (isFinite(o.t)) o.t /= k;
      }
      out.push(o);
    }
    return out;
  }

  function isHidden (n) {
    var h = cfg.interaction.hidden || [];
    return h.indexOf(n.label) >= 0 || h.indexOf(n.key) >= 0 || !!state.off['c:' + n.label] || (!!state.off['o:'] && n.isOthers);
  }

  function findNode (list, key) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i];
      if (key.indexOf(list[i].key + CS) === 0) return findNode(childrenOf(list[i]), key);
    }
    return null;
  }

  /** Visible nodes after drill-down. */
  function drillNodes (base) {
    var D = cfg.drill;
    if (!D.enabled || !raw.dims.length) return base;
    if (D.mode === 'focus' && state.focus.length) {
      var f = findNode(base, state.focus[state.focus.length - 1]);
      if (f) {
        var kids = childrenOf(f).filter(function (n) { return !isHidden(n); });
        if (kids.length) return kids;
      }
      state.focus = [];
      return base;
    }
    if (D.mode === 'expandAll' && state.level > 0) {
      var lvl = Math.min(state.level, raw.dims.length);
      var expand = function (list) {
        var out = [];
        list.forEach(function (n) {
          if (n.depth < lvl && n.depth < raw.dims.length) out = out.concat(expand(childrenOf(n)));
          else out.push(n);
        });
        return out;
      };
      return expand(base);
    }
    if (D.mode === 'expandOne') {
      var walk = function (list) {
        var out = [];
        list.forEach(function (n) {
          if (state.expanded[n.key] && n.depth < raw.dims.length) out = out.concat(walk(childrenOf(n)));
          else out.push(n);
        });
        return out;
      };
      return walk(base);
    }
    return base;
  }

  function isDrilled () {
    var D = cfg.drill;
    if (!D.enabled) return false;
    if (D.mode === 'focus') return state.focus.length > 0;
    if (D.mode === 'expandAll') return state.level > 0;
    return Object.keys(state.expanded).length > 0;
  }

  /** Group of each node (shown under the axis): drill parent or outer Dimension fields. */
  function assignGroups (nodes) {
    var G = cfg.groups;
    nodes.forEach(function (n) {
      n.grp = null;
      if (G.mode === 'none') return;
      if (n.parent && !(cfg.drill.mode === 'focus')) {
        n.grp = { id: 'p:' + n.parent.key, label: n.parent.label, color: G.color };
      } else if (n.outer && n.outer.length) {
        n.grp = { id: 'o:' + n.outer.join(SEP), label: n.outer.join(' · '), color: G.color };
      }
    });
  }

  /** opts.panel: only that panel's rows (opts.reuse: rows already prepared this paint). */
  function buildView (opts) {
    opts = opts || {};
    if (!opts.reuse) prepareRows();
    onlyM = opts.measure || null; // a measure panel: just that measure
    try { return buildView1(opts); } finally { onlyM = null; }
  }

  function buildView1 (opts) {
    var axisType = axisTypeOf();
    var series = seriesDefs(axisType);
    var all = baseNodes(axisType, opts.panel, opts.panelKey);
    var allSorted = sortNodes(all, raw.catFields.length > 1 || axisType === 'measureNames' && raw.catFields.length > 0);
    var visible = allSorted.filter(function (n) { return !isHidden(n); });
    // Top N with Dimension fields works on the rows (prepareRows); without, on the measure bars
    var base = (raw.dimFields || []).length ? visible : applyTopN(visible);
    if (cfg.topN.enabled && !(raw.dimFields || []).length) base = sortNodes(base, false);
    var nodes = drillNodes(base).filter(function (n) { return !isHidden(n); });
    assignGroups(nodes);
    var M0 = raw.measures.length ? raw.measures[0].key : null; // panel per measure: the legend's member items count for every measure
    var visSeries = series.filter(function (s) { return !state.off['s:' + s.key] && !(onlyM && s.member != null && state.off['s:' + M0 + SS + s.member]); });
    var v = {
      axisType: axisType,
      series: series,
      visSeries: visSeries,
      allNodes: allSorted,
      base: base,
      nodes: nodes,
      layout: cfg.chart.layout,
      cmode: colorMode(onlyM && raw.measures.length > 1 ? raw.measures.length : series.length),
      measure: onlyM ? onlyM.key : null,
      noTarget: !!onlyM && onlyM !== raw.measures[0] // the target compares with the first measure: only in its panels
    };
    if (v.layout === 'diverging' && visSeries.length < 2) v.layout = 'regular';
    if ((v.layout === 'stacked' || v.layout === 'stacked100' || v.layout === 'overlap') && visSeries.length < 2) v.layout = 'regular';
    v.style = v.layout === 'regular' || v.layout === 'overlap' || v.layout === 'diverging' ? cfg.chart.style : 'bar';
    if (v.layout === 'stacked100' && cfg.chart.style === 'progress') v.style = 'bar';
    prepareValues(v);
    return v;
  }

  // ---------------------------------------------------------------------------
  // Values as drawn (stacking, 100%, diverging) and colours
  // ---------------------------------------------------------------------------
  function prepareValues (v) {
    var S = v.visSeries;
    var divNeg = {};
    if (v.layout === 'diverging') {
      var negIdx = cfg.diverging.firstSide === 'neg' ? 0 : 1;
      S.forEach(function (s, i) { divNeg[s.key] = i === negIdx || (i > 1 && i % 2 === negIdx); });
    }
    v.divNeg = divNeg;
    var totalsBySeries = {};
    v.nodes.forEach(function (n) {
      n.bars = [];
      var pos = 0;
      var neg = 0;
      var sumAbs = 0;
      S.forEach(function (s) { var o = n.vals[s.key]; if (o) sumAbs += Math.abs(o.v); });
      S.forEach(function (s, si) {
        var o = n.vals[s.key];
        if (!o) return;
        var val = o.v;
        totalsBySeries[s.key] = (totalsBySeries[s.key] || 0) + val;
        var shown = val;
        if (v.layout === 'stacked100') shown = sumAbs ? val / sumAbs : 0;
        if (v.layout === 'diverging') shown = divNeg[s.key] ? -Math.abs(val) : Math.abs(val);
        var from = 0;
        var to = shown;
        if (v.layout === 'stacked' || v.layout === 'stacked100' || v.layout === 'diverging') {
          if (shown >= 0) { from = pos; pos += shown; to = pos; } else { from = neg; neg += shown; to = neg; }
        }
        n.bars.push({ node: n, s: s, si: si, v: val, fv: o.fv, shown: shown, from: from, to: to, count: o.n });
      });
      n.stackPos = pos;
      n.stackNeg = neg;
    });
    v.totalsBySeries = totalsBySeries;
    // previous bar of the same series (labels: difference from previous)
    var prev = {};
    v.nodes.forEach(function (n, i) {
      n.idx = i;
      n.bars.forEach(function (b) { b.prev = prev[b.s.key]; prev[b.s.key] = b; });
    });
    assignColors(v);
  }

  function assignColors (v) {
    var C = cfg.colors;
    var mode = v.cmode;
    var valField = C.valueField || '__self';
    var valueOf = function (n, b) {
      if (valField === '__self') return b.v;
      if (n.vals[valField]) return n.vals[valField].v;
      if (b.s.member != null) return b.s.measure === valField ? b.v : n.mv && n.mv[valField] != null ? n.mv[valField] : NaN;
      if (n.measureKey) return n.measureKey === valField ? b.v : NaN;
      return NaN;
    };
    var lo = Infinity;
    var hi = -Infinity;
    if (mode === 'value') {
      v.nodes.forEach(function (n) { n.bars.forEach(function (b) { var x = valueOf(n, b); if (isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }); });
    }
    var hlSrc = C.highlightBy || 'auto';
    var hl = {};
    (C.highlight || []).forEach(function (m) { hl[m] = 1; });
    var hlTop = {};
    if (C.highlightTop > 0) {
      Bc.sortBy(v.nodes.filter(function (n) { return !n.isOthers; }), function (a, b) { return b.total - a.total; })
        .slice(0, C.highlightTop).forEach(function (n) { hlTop[n.key] = 1; });
    }
    var dk = dimLevelOf();

    v.nodes.forEach(function (n) {
      n.bars.forEach(function (b) {
        var c;
        var inherited = false;
        if (n.isOthers) c = cfg.topN.color;
        else if (b.s.member != null && (mode === 'measures' || mode === 'single' || (mode === 'dimensions' && isSeriesField(dk)))) c = b.s.color;
        else if (mode === 'measures') {
          var mk = n.measureKey || b.s.measure || measureKeyByName(memberOf(n, b, 'measures'));
          c = mk ? measureColor(mk) : C.single;
        } else if (mode === 'dimensions') {
          if (n.dimPath && n.dimPath[dk] != null) { c = dimColor(dk, n.dimPath[dk]); inherited = dk !== n.dimPath.length - 1; } else c = C.single;
        } else if (mode === 'value') {
          var x = valueOf(n, b);
          c = isFinite(x) ? Bc.mix(C.lowColor, C.highColor, hi > lo ? (x - lo) / (hi - lo) : 1) : C.mutedColor;
        } else if (mode === 'sign') c = b.v < 0 ? C.negColor : C.posColor;
        else if (mode === 'highlight') {
          var mem = memberOf(n, b, hlSrc);
          c = (mem != null && hl[mem]) || hlTop[n.key] ? C.highlightColor : C.mutedColor;
        } else c = Bc.seriesCfg(cfg, b.s.key).color || C.single;
        // drilled children that inherit their parent's colour: shades of it
        if (n.parent && cfg.drill.tintChildren && !n.isOthers && (mode === 'single' || (mode === 'dimensions' && inherited))) {
          var sib = childrenOf(n.parent);
          var k = sib.indexOf(n);
          c = Bc.tint(c, sib.length > 1 ? (k / (sib.length - 1)) * 0.55 : 0);
        }
        (C.rules || []).some(function (r) {
          var y = Number(r.value);
          var ok = r.op === '>' ? b.v > y : r.op === '>=' ? b.v >= y : r.op === '<' ? b.v < y : r.op === '<=' ? b.v <= y : b.v === y;
          if (ok && Bc.normalizeHex(r.color)) { c = r.color; return true; }
          return false;
        });
        b.color = Bc.normalizeHex(c) || '#8C96A3';
      });
    });
  }


  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg || !raw) return;
    var v;
    try {
      v = buildView();
    } catch (e) {
      console.error('Bar Chart: could not build the chart', e);
      showEmpty('Could not draw the chart. See the console for details.');
      return;
    }
    view = v;
    if (!v.nodes.length || !v.series.length) {
      showEmpty(v.allNodes.length ? 'Every bar is hidden. Right-click the chart → <b>Show hidden bars</b>.' : 'No values to show.');
      if (v.allNodes.length) { el.card.classList.remove('is-empty'); el.hint.style.display = 'none'; }
      return;
    }
    el.card.classList.remove('is-empty');
    el.hint.style.display = '';
    hideTooltipIfStale();
    paintCard();
    paintHeader(v);
    paintDrillbar(v);
    paintLegend(v);
    drawPlot(v);
    indexHover();
    markSelection();
    state.animate = false;
  }

  // ---------------------------------------------------------------------------
  // Small multiples: one chart per value of the Panels fields (Grouping tab),
  // like dimensions on Tableau's Rows or Columns. Same series, colours and legend;
  // optionally one value axis for all panels.
  // ---------------------------------------------------------------------------
  function panelMembers () {
    var P = raw.panelIdx;
    var seen = {};
    var data = [];
    raw.rows.forEach(function (r) { if (r.pm != null && !seen[r.pm]) { seen[r.pm] = 1; data.push(r.pm); } });
    if (P.length !== 1) return data;
    var order = (raw.levelValues[P[0]] || []).filter(function (x) { return seen[x]; });
    data.forEach(function (x) { if (order.indexOf(x) < 0) order.push(x); });
    return order;
  }

  /** The panels: per measure (outer) and/or per value of the panel fields. */
  function panelList () {
    var dims = raw.panelIdx && raw.panelIdx.length ? panelMembers() : [null];
    var ms = measurePanels() ? raw.measures : [null];
    var out = [];
    ms.forEach(function (m) {
      dims.forEach(function (x) {
        var t = [m ? measureLabel(m) : null, x].filter(function (s) { return s != null; }).join(' \u00b7 ');
        out.push({ m: t, v: buildView({ panel: x, measure: m, panelKey: m ? m.key + '\u0005' + (x == null ? '' : x) : x, reuse: true }) });
      });
    });
    return out;
  }

  function drawPlot (v) {
    var host = el.plot.querySelector('.panes');
    if ((!raw.panelIdx || !raw.panelIdx.length) && !measurePanels()) {
      if (host) host.remove();
      el.svg.style.display = '';
      drawChart(v);
      return;
    }
    var PN = cfg.panels;
    var panes = panelList()
      .filter(function (p) { return p.v.nodes.length; });
    el.svg.style.display = 'none';
    while (el.svg.firstChild) el.svg.removeChild(el.svg.firstChild);
    drawn = []; catRefs = [];
    if (!host) { host = document.createElement('div'); host.className = 'panes'; el.plot.appendChild(host); }
    host.innerHTML = '';
    var n = panes.length;
    var W = el.plot.clientWidth; var H = el.plot.clientHeight;
    var cols = PN.layout === 'rows' ? 1 : PN.layout === 'columns' ? n
      : PN.columns > 0 ? Math.min(PN.columns, n) : Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (W / Math.max(1, H))))));
    host.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    host.style.gridTemplateRows = 'repeat(' + Math.ceil(n / cols) + ', minmax(0, 1fr))';
    host.style.gap = PN.gap + 'px';
    panes.forEach(function (p) {
      var d = document.createElement('div'); d.className = 'pane';
      if (PN.showTitle) {
        var t = document.createElement('div'); t.className = 'pane-title'; t.textContent = p.m;
        t.style.fontSize = PN.titleSize + 'px'; t.style.fontWeight = String(PN.titleWeight); t.style.color = PN.titleColor;
        t.style.fontFamily = Bc.fontStack(cfg.numbers.font); t.style.textAlign = PN.titleAlign;
        d.appendChild(t);
      }
      var box = document.createElement('div'); box.className = 'pane-plot';
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'svg');
      box.appendChild(svg); d.appendChild(box); host.appendChild(d);
      p.svg = svg; p.box = box;
    });
    // shared value axis: one range for all panels — per measure with a panel per measure,
    // like Measure Names on Rows in Tableau (each measure keeps its own axis)
    var exts = {};
    panes.forEach(function (p) {
      p.W = p.box.clientWidth; p.H = p.box.clientHeight;
      if (!PN.shareAxis) return;
      var e = drawChart(p.v, { svg: p.svg, W: p.W, H: p.H, extentOnly: true });
      var k = p.v.measure || '';
      var ext = exts[k];
      if (e) exts[k] = ext ? { lo: Math.min(ext.lo, e.lo), hi: Math.max(ext.hi, e.hi), llo: Math.min(ext.llo, e.llo), lhi: Math.max(ext.lhi, e.lhi) } : e;
    });
    panes.forEach(function (p) { drawChart(p.v, { svg: p.svg, W: p.W, H: p.H, append: true, extent: exts[p.v.measure || ''] || null }); });
  }

  function applyFont (node, f) {
    node.style.fontFamily = Bc.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Bc.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.body.style.marginTop = c.gap + 'px';
    el.plot.style.backgroundColor = c.plotBgOpacity > 0 ? Bc.rgba(c.plotBg, c.plotBgOpacity / 100) : 'transparent';
  }

  function defaultTitle (v) {
    var m = raw.measures.map(measureLabel).join(' & ');
    if (v.axisType === 'measureNames' || !raw.catFields.length) return m;
    return m + ' by ' + raw.catFields[raw.catFields.length - 1].name;
  }

  function paintHeader (v) {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';

    if (showIcon) {
      if (ic.source === 'builtin') {
        var r = Bc.iconHtml(ic.builtinId, ic.color, iconTarget());
        el.icon.innerHTML = r.html;
        setIconBox(r.w, r.h);
      } else if (ic.mask && ic.dataUrl) {
        // uploaded image as a one-colour shape, like the built-ins: follows Size and Color
        var t = iconTarget();
        var iw = ic.w || 1; var ih = ic.h || 1;
        var W = iw >= ih ? t : Math.max(1, Math.round(t * iw / ih));
        var H = iw >= ih ? Math.max(1, Math.round(t * ih / iw)) : t;
        var mk = 'url(' + ic.dataUrl + ') center / contain no-repeat';
        el.icon.innerHTML = '<span class="kpi3-icon-mask" style="display:block;width:' + W + 'px;height:' + H + 'px;background-color:' + ic.color +
          ';-webkit-mask:' + mk + ';mask:' + mk + '"></span>';
        setIconBox(W, H);
      } else {
        var img = new Image();
        img.alt = '';
        img.onload = function () { sizeImageIcon(img); };
        img.src = ic.dataUrl;
        el.icon.appendChild(img);
        if (img.complete) sizeImageIcon(img);
      }
    }

    var t = cfg.title;
    applyFont(el.title, t);
    el.title.textContent = t.text ? fillParams(t.text) : defaultTitle(v);
    el.title.style.textAlign = t.align || 'left';
    el.title.style.display = t.show === false ? 'none' : '';

    var ex = cfg.explanation;
    var exText = fillParams(ex.text);
    var hasText = ex.show && !!exText;
    applyFont(el.explanation, ex);
    el.explanation.style.textAlign = t.align || 'left';
    el.explanation.textContent = hasText ? exText : ' ';
    el.explanation.style.display = hasText || ex.reserveSpace ? '' : 'none';

    var headVisible = showIcon || t.show !== false || hasText || ex.reserveSpace;
    el.card.classList.toggle('no-head', !headVisible);
    if (!headVisible) el.body.style.marginTop = '0px';
    updateIconSpan();
  }

  function sizeImageIcon (img) {
    var t = iconTarget();
    var w = img.naturalWidth || t;
    var h = img.naturalHeight || t;
    var W, H;
    if (w >= h) { W = t; H = Math.max(1, Math.round(t * h / w)); } else { H = t; W = Math.max(1, Math.round(t * w / h)); }
    img.style.width = W + 'px';
    img.style.height = H + 'px';
    setIconBox(W, H);
  }

  function iconTarget () {
    var n = Number(cfg.icon.size);
    return isFinite(n) && n > 0 ? Math.max(8, Math.min(128, n)) : 24;
  }

  var iconBoxH = 0;
  function setIconBox (w, h) {
    el.icon.style.width = w + 'px';
    el.icon.style.height = h + 'px';
    iconBoxH = h;
    updateIconSpan();
  }

  function updateIconSpan () {
    var head = el.icon.parentNode;
    var titleH = el.title.offsetHeight || 19;
    var hasExplanation = el.explanation.style.display !== 'none';
    head.classList.toggle('icon-span', hasExplanation && iconBoxH > titleH * 1.5);
  }

  // ---------------------------------------------------------------------------
  // Drill breadcrumb
  // ---------------------------------------------------------------------------
  function paintDrillbar (v) {
    var on = isDrilled() && cfg.drill.showBar;
    el.drillbar.classList.toggle('is-on', on);
    el.drillbar.innerHTML = '';
    if (!on) return;
    var back = button('‹ Back', drillUp);
    var reset = button('Reset', resetDrill);
    var crumb = document.createElement('span');
    crumb.className = 'crumb';
    var D = cfg.drill;
    if (D.mode === 'focus') {
      var labels = state.focus.map(function (k) { var n = findNode(v.base, k); return n ? n.label : ''; });
      crumb.innerHTML = 'All › ' + labels.map(function (l, i) { return i === labels.length - 1 ? '<b>' + esc(l) + '</b>' : esc(l); }).join(' › ');
    } else if (D.mode === 'expandAll') {
      crumb.innerHTML = 'Showing <b>' + esc(raw.dims.slice(0, state.level).map(function (d) { return d.name; }).join(' › ')) + '</b>';
    } else {
      var names = Object.keys(state.expanded).map(function (k) { var n = findNode(v.base, k); return n ? n.label : null; }).filter(Boolean);
      crumb.innerHTML = 'Expanded: <b>' + esc(names.join(', ')) + '</b>';
    }
    el.drillbar.append(back, reset, crumb);
  }

  function button (text, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }

  // ---------------------------------------------------------------------------
  // Legend
  // ---------------------------------------------------------------------------
  function legendItems (v) {
    var L = cfg.legend;
    var items = [];
    var mode = v.cmode;
    if (mode === 'dimensions') {
      var k = dimLevelOf();
      var tot = {};
      raw.rowsAll.forEach(function (r) {
        var x = r.d[k];
        tot[x] = (tot[x] || 0) + Object.keys(r.v).reduce(function (a, m) { return a + r.v[m]; }, 0);
      });
      var vals = (raw.levelValues[k] || []).slice();
      if (raw.rows.some(function (r) { return r.oth && r.d[k] === (cfg.topN.label || 'Others'); })) vals.push(cfg.topN.label || 'Others');
      vals.forEach(function (x) {
        var present = raw.rows.some(function (r) { return r.d[k] === x; }) || state.off['d:' + k + '|' + x];
        if (!present) return;
        var isOth = x === (cfg.topN.label || 'Others') && raw.rows.some(function (r) { return r.oth && r.d[k] === x; });
        items.push({ key: 'd:' + k + '|' + x, hover: 'd:' + k + '|' + x, name: x, color: isOth ? cfg.topN.color : dimColor(k, x), value: tot[x], toggle: !isOth });
      });
    } else if (mode === 'sign') {
      items.push({ id: 'sign:pos', name: 'Positive', color: cfg.colors.posColor }, { id: 'sign:neg', name: 'Negative', color: cfg.colors.negColor });
    } else if (mode === 'highlight') {
      items.push({ id: 'hl:on', name: 'Highlighted', color: cfg.colors.highlightColor }, { id: 'hl:off', name: 'Other', color: cfg.colors.mutedColor });
    } else if (mode === 'value') {
      items.push({ ramp: true });
    } else if (v.axisType === 'measureNames') {
      // each bar is a measure
      raw.measures.forEach(function (m) {
        var n = v.allNodes.find(function (x) { return x.measureKey === m.key; });
        items.push({ key: 'c:' + m.name, hover: 'c:' + m.name, name: measureLabel(m),
          color: mode === 'measures' ? measureColor(m.key) : cfg.colors.single, value: n ? n.total : null, toggle: true });
      });
    } else {
      // With Top N + Others, each measure gets a "Top N" and an "Others" item
      var oth = cfg.topN.enabled && v.nodes.some(function (n) { return n.isOthers; }) || state.off['o:'];
      var topWord = (cfg.topN.direction === 'bottom' ? 'Bottom ' : 'Top ') + cfg.topN.n;
      var othLabel = cfg.topN.label || 'Others';
      // each item takes the colour its bars are actually drawn in (stacks split by a dimension,
      // rules, one colour …), so the legend always matches the chart
      var drawnColor = {};
      v.nodes.forEach(function (n) {
        if (n.isOthers) return;
        (n.bars || []).forEach(function (b) { if (!(b.s.key in drawnColor)) drawnColor[b.s.key] = b.color; });
      });
      // a panel per measure and bars split by a dimension: one item per member (it shows/hides it in every panel)
      var perMember = measurePanels() && v.series.some(function (s) { return s.member != null; });
      var M0 = raw.measures[0].key;
      v.series.forEach(function (s) {
        if (perMember) {
          if (s.measure !== M0) return;
          s = Object.assign({}, s, { name: Bc.seriesCfg(cfg, s.key).label || s.member });
        }
        var color = drawnColor[s.key] || (mode === 'measures' ? s.color : (Bc.seriesCfg(cfg, s.key).color || cfg.colors.single));
        if (!oth) {
          items.push({ key: 's:' + s.key, hover: 's:' + s.key, name: s.name, color: color, value: v.totalsBySeries[s.key], toggle: true });
          return;
        }
        var topV = 0; var othV = 0;
        v.nodes.forEach(function (n) { var o = n.vals[s.key]; if (!o) return; if (n.isOthers) othV += o.v; else topV += o.v; });
        var short = L.topNNames === 'group';
        items.push({ key: 's:' + s.key, hover: 's:' + s.key + '|o:top', name: short ? topWord : s.name + ' – ' + topWord, long: s.name + ' – ' + topWord, short: topWord, color: color, value: topV, toggle: true });
        items.push({ key: 'o:', hover: 's:' + s.key + '|o:oth', name: short ? othLabel : s.name + ' – ' + othLabel, long: s.name + ' – ' + othLabel, short: othLabel, color: cfg.topN.color, value: othV, toggle: true });
      });
    }
    // segments with their own colours (Breakdown → Colors → Custom): one item per member
    if (cfg.breakdown.show && cfg.breakdown.colorMode === 'custom' && raw.dims.length && mode !== 'dimensions') {
      var segSeen = {};
      v.nodes.forEach(function (n) {
        if (!segSpec(n)) return;
        (n.bars || []).forEach(function (b) {
          segmentsOf(n, b.s.key, segSpec(n)).forEach(function (sg) {
            if (segSeen[sg.member]) return;
            segSeen[sg.member] = 1;
            var col = cfg.breakdown.colors[sg.member];
            if (col) items.push({ id: 'seg:' + sg.member, name: sg.member, color: col });
          });
        });
      });
    }
    if (cfg.chart.showBars === false) items = [];
    renameItems(items);
    if (L.sort === 'name') items = Bc.sortBy(items, function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    if (L.sort === 'valDesc') items = Bc.sortBy(items, function (a, b) { return (b.value || 0) - (a.value || 0); });
    var barCount = items.length;
    if (L.includeLines && cfg.chart.showLines !== false) {
      raw.lines.forEach(function (l, i) {
        var lc = Bc.lineCfg(cfg, l.key);
        var sum = 0; var any = false;
        v.nodes.forEach(function (n) { if (isFinite(n.l[l.key])) { sum += n.l[l.key]; any = true; } });
        items.push({ key: 'l:' + l.key, hover: 'l:' + l.key, name: lineLabel(l), color: lineColor(l.key, i), line: lc, toggle: true, value: any ? sum : null, fmt: lc.fmt });
      });
    }
    if (L.includeTarget && targetInfo() && cfg.target.show && cfg.target.style !== 'none' && cfg.chart.showBars !== false) {
      var ts = 0; var tany = false;
      v.nodes.forEach(function (n) { if (isFinite(n.t)) { ts += n.t; tany = true; } });
      items.push({ key: 't:', hover: 't:', name: fieldLabel(targetInfo()), color: cfg.target.color, target: true, toggle: true, value: tany ? ts : null });
    }
    if (L.includeRefs) {
      cfg.refs.forEach(function (r, i) {
        var rc = Bc.refCfg(r);
        if (!rc.show) return;
        items.push({ key: 'r:' + i, hover: 'r:' + i, name: rc.label ? rc.label.replace(/\{type\}/g, refName(rc)).replace(/:?\s*\{value\}/g, '') || refName(rc) : refName(rc), color: rc.color, ref: rc, toggle: true });
      });
    }
    renameItems(items);
    items.barCount = barCount;
    return items;
  }

  /** Legend → Item names: custom names (may hold <Parameter>), by a stable item id. */
  function renameItems (items) {
    var N = cfg.legend.names || {};
    items.forEach(function (it) {
      if (it.ramp || it.orig != null) return;
      it.id = it.id || it.hover || it.key || ('n:' + it.name);
      it.orig = it.name;
      var c = N[it.id];
      if (c != null && String(c).trim() !== '') it.name = fillParams(c);
    });
  }

  function paintLegend (v) {
    var L = cfg.legend;
    var lg = el.legend;
    lg.innerHTML = '';
    el.body.className = 'body legend-' + L.position;
    if (!L.show) return;
    var items = legendItems(v);
    if (L.autoHide && items.length <= 1 && !items.some(function (i) { return i.ramp; })) return;
    lg.style.fontFamily = Bc.fontStack(L.font);
    lg.style.fontSize = L.size + 'px';
    lg.style.fontWeight = String(L.weight);
    lg.style.color = L.color;
    lg.style.columnGap = L.gap + 'px';
    var vertical = L.position === 'left' || L.position === 'right';
    lg.style.justifyContent = vertical ? 'center' : (L.align === 'center' ? 'center' : L.align === 'end' ? 'flex-end' : 'flex-start');
    lg.style.alignItems = vertical ? (L.align === 'center' ? 'center' : L.align === 'end' ? 'flex-end' : 'flex-start') : 'center';
    lg.classList.toggle('is-boxed', !!L.box);
    lg.style.background = L.box ? L.boxColor : '';
    lg.style.borderColor = L.box ? L.boxBorder : '';
    if (L.showTitle) {
      var t = document.createElement('span');
      t.className = 'lg-title';
      t.textContent = L.title || (v.cmode === 'dimensions' && raw.dimFields[dimLevelOf()] ? raw.dimFields[dimLevelOf()].name : v.cmode === 'measures' ? 'Measures' : 'Legend');
      lg.appendChild(t);
    }
    var fmt = fmtOf(cfg.labels.fmt);
    items.forEach(function (it) {
      var d = document.createElement('span');
      d.className = 'lg-item';
      if (it.ramp) {
        var lo = Infinity; var hi = -Infinity;
        v.nodes.forEach(function (n) { n.bars.forEach(function (b) { var x = cfg.colors.valueField && cfg.colors.valueField !== '__self' && n.vals[cfg.colors.valueField] ? n.vals[cfg.colors.valueField].v : b.v; lo = Math.min(lo, x); hi = Math.max(hi, x); }); });
        d.innerHTML = '<span>' + esc(Bc.formatNumber(lo, fmt)) + '</span><span class="lg-ramp" style="background:linear-gradient(90deg,' +
          cfg.colors.lowColor + ',' + cfg.colors.highColor + ')"></span><span>' + esc(Bc.formatNumber(hi, fmt)) + '</span>';
        lg.appendChild(d);
        return;
      }
      d.appendChild(legendMark(it));
      var nm = document.createElement('span');
      nm.className = 'lg-name';
      nm.textContent = it.name;
      d.appendChild(nm);
      if (L.showValues && it.value != null && isFinite(it.value)) {
        var vl = document.createElement('span');
        vl.className = 'lg-val';
        vl.textContent = Bc.formatNumber(it.value, it.fmt ? fmtOf(it.fmt) : fmt);
        d.appendChild(vl);
      }
      if (it.key && state.off[it.key]) d.classList.add('is-off');
      if (it.key && it.toggle && L.interactive) {
        d.classList.add('is-click');
        d.title = 'Click to hide or show';
        d.addEventListener('click', function () {
          if (state.off[it.key]) delete state.off[it.key]; else state.off[it.key] = true;
          state.animate = false;
          paint();
        });
      }
      if (it.hover && L.hoverHighlight) {
        d.addEventListener('mouseenter', function () { setHover(it.hover); });
        d.addEventListener('mouseleave', function () { setHover(null); });
      }
      lg.appendChild(d);
    });
  }

  function legendMark (it) {
    var L = cfg.legend;
    var s = Math.max(4, L.markerSize);
    var m = document.createElement('span');
    m.className = 'lg-mark';
    if (it.line || it.ref || it.target) {
      var dash = it.ref ? Bc.dashArray(it.ref.style, 2) : it.line ? Bc.dashArray(it.line.style, 2) : '';
      m.innerHTML = '<svg width="' + (s * 2) + '" height="' + s + '" viewBox="0 0 ' + (s * 2) + ' ' + s + '"><line x1="0" x2="' + (s * 2) + '" y1="' + (s / 2) +
        '" y2="' + (s / 2) + '" stroke="' + it.color + '" stroke-width="2" stroke-dasharray="' + dash + '"/>' +
        (it.line && it.line.marker !== 'none' ? '<circle cx="' + s + '" cy="' + (s / 2) + '" r="' + Math.min(3.5, s / 2) + '" fill="#fff" stroke="' + it.color + '" stroke-width="1.5"/>' : '') + '</svg>';
      return m;
    }
    var shape = L.marker;
    m.style.width = (shape === 'bar' ? s * 1.8 : shape === 'line' ? s * 2 : s) + 'px';
    m.style.height = (shape === 'line' ? 3 : shape === 'bar' ? s * 0.7 : s) + 'px';
    m.style.background = it.color;
    m.style.borderRadius = shape === 'circle' ? '50%' : shape === 'rounded' ? Math.round(s / 3) + 'px' : shape === 'line' ? '2px' : shape === 'bar' ? '2px' : '1px';
    return m;
  }

  function lineColor (key, i) {
    var lc = Bc.lineCfg(cfg, key);
    if (lc.color && Bc.normalizeHex(lc.color)) return lc.color;
    var defaults = ['#17202B', '#EB644C', '#0E7C66', '#6B4FB0'];
    return defaults[i % defaults.length];
  }

  function refName (r) {
    var names = { constant: 'Reference', average: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum', percentile: 'P' + r.percentile, total: 'Total' };
    return names[r.type] || 'Reference';
  }

  /** Every number uses the chart's format (Value Text tab); tooltips can have their own (tipFmt). */
  function fmtOf (f) {
    return cfg.format;
  }

  function tipFmt () {
    return cfg.tooltip.ownFormat ? cfg.tooltip.fmt : cfg.format;
  }

  // ---------------------------------------------------------------------------
  // Chart helpers
  // ---------------------------------------------------------------------------
  var measureCtx = null;
  var twCache = {};
  var twCount = 0;
  function textWidth (text, size, weight, family) {
    var font = (weight || 400) + ' ' + size + 'px ' + Bc.fontStack(family);
    var k = font + '\u0001' + text;
    var w = twCache[k];
    if (w !== undefined) return w;
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (measureCtx.font !== font) measureCtx.font = font;
    w = measureCtx.measureText(String(text)).width;
    if (++twCount > 20000) { twCache = {}; twCount = 0; }
    twCache[k] = w;
    return w;
  }

  function niceStep (r) {
    if (!(r > 0) || !isFinite(r)) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(r)));
    var f = r / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }

  /** Axis range + ticks from the data extent and an axis config (base / max / ticks). */
  function scaleFor (lo, hi, a, opts) {
    opts = opts || {};
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    var base = opts.forceZero ? 'zero' : a.base;
    if (base === 'zero') {
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    } else if (base === 'auto') {
      var range = hi - lo || Math.abs(hi) * 0.2 || 1;
      var pad = Math.max(0, Number(a.padding != null ? a.padding : 20) || 0) / 100 * range;
      if (lo >= 0) lo = Math.max(0, lo - pad);
      else if (hi <= 0) hi = Math.min(0, hi + pad);
      else { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    } else {
      lo = Number(a.manualMin) || 0;
      hi = Math.max(hi, lo);
    }
    if (a.maxMode === 'manual' && Number(a.manualMax) > lo) hi = Number(a.manualMax);
    if (opts.maxCap != null) hi = Math.min(hi, opts.maxCap);
    if (hi === lo) hi = lo + 1;
    var count = Math.max(2, Math.min(14, Number(a.ticks) || 5));
    var step = niceStep((hi - lo) / count);
    var min = base === 'manual' ? lo : Math.floor(lo / step + 1e-9) * step;
    var max = a.maxMode === 'manual' ? hi : Math.ceil(hi / step - 1e-9) * step;
    if (opts.exactMax != null) max = opts.exactMax;
    if (max <= min) max = min + step;
    var ticks = [];
    for (var t = Math.ceil(min / step - 1e-9) * step; t <= max + step * 1e-6; t += step) {
      ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
    }
    return { min: min, max: max, step: step, ticks: ticks };
  }

  /** Tick texts, with enough decimals to tell neighbours apart. */
  function tickTexts (ticks, f, opts) {
    var maxTick = Math.max.apply(null, ticks.map(Math.abs).concat([0]));
    var force = f.scale === 'dynamic' ? Bc.pickScale(maxTick, 'dynamic')
      : f.scale === 'percentDynamic' ? Bc.pickScale(f.pctFromRatio ? maxTick * 100 : maxTick, 'dynamic') : null;
    var out;
    var use = Bc.clone(f);
    // decimals needed to write every tick exactly (0.25M, not 0.3M)
    var div = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[force] || 1;
    var stp = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) / div : 1;
    if (/percent/.test(f.scale) && f.pctFromRatio) stp *= 100;
    var need = 0;
    while (need < 4 && Math.abs(Math.round(stp * Math.pow(10, need)) - stp * Math.pow(10, need)) > 1e-6) need++;
    var startDec = opts && opts.exact ? need : Math.max(need, f.decimals);
    for (var d = startDec; d <= Math.max(startDec, 4); d++) {
      use.decimals = d;
      out = ticks.map(function (t) { return Bc.formatNumber(t, use, { forceScale: force }); });
      var u = {};
      out.forEach(function (t) { u[t] = 1; });
      if (opts && opts.abs) out = ticks.map(function (t) { return Bc.formatNumber(t, use, { forceScale: force, abs: true }); });
      if (Object.keys(u).length === out.length || f.scale === 'workbook') break;
    }
    var zero = Bc.formatNumber(0, Bc.merge(f, { decimals: 0 }), { forceScale: '' });
    return out.map(function (t, i) { return ticks[i] === 0 ? zero : t; });
  }

  function wrapText (text, width, maxLines, size, weight, family) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length; i++) {
      var tryLine = cur ? cur + ' ' + words[i] : words[i];
      if (textWidth(tryLine, size, weight, family) <= width || !cur) cur = tryLine;
      else { lines.push(cur); cur = words[i]; }
    }
    if (cur) lines.push(cur);
    if (!lines.length) lines = [''];
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = ellipsize(lines[maxLines - 1] + '…', width, size, weight, family);
    }
    return lines.map(function (l) { return ellipsize(l, width, size, weight, family); });
  }

  function ellipsize (text, width, size, weight, family) {
    text = String(text);
    if (textWidth(text, size, weight, family) <= width) return text;
    var t = text.replace(/…$/, '');
    while (t.length > 1 && textWidth(t + '…', size, weight, family) > width) t = t.slice(0, -1);
    return t + '…';
  }

  function node (tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] != null && attrs[k] !== '') n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }

  function lineAttrs (l) {
    return { stroke: l.color, 'stroke-width': l.width, 'stroke-dasharray': Bc.dashArray(l.style, l.width), 'shape-rendering': 'crispEdges' };
  }

  function fx (n) { return Math.round(n * 100) / 100; }

  /** Rounded polygon through [x, y, r] points (cubic corners, any orientation). */
  function roundPoly (pts) {
    var n = pts.length;
    var d = '';
    for (var i = 0; i < n; i++) {
      var c = pts[i];
      var p = pts[(i - 1 + n) % n];
      var q = pts[(i + 1) % n];
      var r = c[2] || 0;
      if (Array.isArray(r)) {
        // elliptical corner: [distance along the edge to the previous point, along the edge to the next]
        var ra = r[0]; var rb2 = r[1];
        if (!(ra > 0.3 && rb2 > 0.3)) { d += (i ? 'L' : 'M') + fx(c[0]) + ' ' + fx(c[1]); continue; }
        var la = Math.hypot(p[0] - c[0], p[1] - c[1]);
        var lb = Math.hypot(q[0] - c[0], q[1] - c[1]);
        var ea = [c[0] + (p[0] - c[0]) / la * ra, c[1] + (p[1] - c[1]) / la * ra];
        var eb = [c[0] + (q[0] - c[0]) / lb * rb2, c[1] + (q[1] - c[1]) / lb * rb2];
        var ke = 0.5523;
        d += (i ? 'L' : 'M') + fx(ea[0]) + ' ' + fx(ea[1]) +
          'C' + fx(ea[0] + (c[0] - ea[0]) * ke) + ' ' + fx(ea[1] + (c[1] - ea[1]) * ke) + ' ' +
          fx(eb[0] + (c[0] - eb[0]) * ke) + ' ' + fx(eb[1] + (c[1] - eb[1]) * ke) + ' ' + fx(eb[0]) + ' ' + fx(eb[1]);
        continue;
      }
      if (r > 0.3) {
        var lp = Math.hypot(p[0] - c[0], p[1] - c[1]);
        var lq = Math.hypot(q[0] - c[0], q[1] - c[1]);
        r = Math.min(r, lp / 2, lq / 2);
      }
      if (!(r > 0.3)) { d += (i ? 'L' : 'M') + fx(c[0]) + ' ' + fx(c[1]); continue; }
      var a = [c[0] + (p[0] - c[0]) / Math.hypot(p[0] - c[0], p[1] - c[1]) * r, c[1] + (p[1] - c[1]) / Math.hypot(p[0] - c[0], p[1] - c[1]) * r];
      var b = [c[0] + (q[0] - c[0]) / Math.hypot(q[0] - c[0], q[1] - c[1]) * r, c[1] + (q[1] - c[1]) / Math.hypot(q[0] - c[0], q[1] - c[1]) * r];
      var k = 0.5523;
      d += (i ? 'L' : 'M') + fx(a[0]) + ' ' + fx(a[1]) +
        'C' + fx(a[0] + (c[0] - a[0]) * k) + ' ' + fx(a[1] + (c[1] - a[1]) * k) + ' ' +
        fx(b[0] + (c[0] - b[0]) * k) + ' ' + fx(b[1] + (c[1] - b[1]) * k) + ' ' + fx(b[0]) + ' ' + fx(b[1]);
    }
    return d + 'Z';
  }

  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------
  /**
   * Draws one chart. opts (small multiples): svg / W / H of a panel, append (keep the
   * other panels' hit areas), extentOnly (just return the value range), extent
   * (use this value range, so panels share one axis).
   */
  function drawChart (v, opts) {
    opts = opts || {};
    var svg = opts.svg || el.svg;
    if (!opts.extentOnly) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      if (!opts.append) { drawn = []; catRefs = []; }
    }
    var W = Math.max(1, opts.W || el.plot.clientWidth);
    var H = Math.max(1, opts.H || el.plot.clientHeight);
    if (!opts.extentOnly) svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!opts.extentOnly && (W < 40 || H < 40)) return;
    var firstItem = drawn.length;

    var vert = cfg.chart.orientation !== 'horizontal';
    var family = cfg.numbers.font;
    var nodes = v.nodes;
    var N = nodes.length;
    var S = v.visSeries;
    var K = Math.max(1, S.length);
    var lay = v.layout;
    var style = v.style;
    var stacked = lay === 'stacked' || lay === 'stacked100' || lay === 'diverging';
    var sideBySide = lay === 'regular' && K > 1;
    var overlap = lay === 'overlap';
    var AV = cfg.axisV;
    var AC = cfg.axisC;
    var LB = cfg.labels;
    var IC = cfg.icons;
    var G = cfg.groups;
    // Show bars / Show lines (Bars and Line Chart tabs)
    var showBars = cfg.chart.showBars !== false;
    var lines = cfg.chart.showLines === false ? [] : raw.lines.filter(function (l) { return !state.off['l:' + l.key]; });
    var centerDiv = lay === 'diverging' && cfg.diverging.labels === 'center';
    // no grow animation for big charts: hundreds of animated bars make every refresh feel slow
    var animate = state.animate && cfg.chart.animate && nodes.length * Math.max(1, v.visSeries.length) <= 300;
    svg.classList.toggle('animate', !!animate);
    svg.style.setProperty('--ms', Math.max(0, cfg.chart.animMs) + 'ms');
    svg.style.setProperty('--dim', String(Math.max(5, Math.min(100, cfg.hover.dimOpacity)) / 100));

    // ---- value extent ------------------------------------------------------
    var lo = Infinity;
    var hi = -Infinity;
    var trackMax = progressMaxFn(v);
    if (showBars) nodes.forEach(function (n) {
      if (stacked) { lo = Math.min(lo, n.stackNeg); hi = Math.max(hi, n.stackPos); }
      n.bars.forEach(function (b) {
        if (!stacked) { lo = Math.min(lo, b.shown); hi = Math.max(hi, b.shown); }
        if (style === 'progress') hi = Math.max(hi, trackMax(n, b));
      });
      if (targetInfo() && !v.noTarget && !state.off['t:'] && cfg.target.show && cfg.target.style !== 'none' && isFinite(n.t) && lay !== 'stacked100') {
        lo = Math.min(lo, n.t); hi = Math.max(hi, n.t);
      }
    });
    if (lo === Infinity) { lo = 0; hi = 1; }
    var refVals = refValues(v);
    refVals.forEach(function (r) { lo = Math.min(lo, r.a, r.b); hi = Math.max(hi, r.a, r.b); });
    // bars hidden: the lines use the main axis
    var lineShared = lines.length && (cfg.lineAxis.mode === 'shared' || !showBars);
    if (lineShared) nodes.forEach(function (n) { lines.forEach(function (l) { if (isFinite(n.l[l.key])) { lo = Math.min(lo, n.l[l.key]); hi = Math.max(hi, n.l[l.key]); } }); });
    if (opts.extentOnly) {
      var elo = Infinity; var ehi = -Infinity; // the lines' own range, so panels can share the line axis too
      nodes.forEach(function (n) { lines.forEach(function (l) { var x = n.l[l.key]; if (isFinite(x)) { elo = Math.min(elo, x); ehi = Math.max(ehi, x); } }); });
      return { lo: lo, hi: hi, llo: elo, lhi: ehi };
    }
    if (opts.extent) { lo = Math.min(lo, opts.extent.lo); hi = Math.max(hi, opts.extent.hi); }
    var aCfg = AV;
    var sopts = {};
    if (style === 'progress' || lay === 'stacked100') sopts.forceZero = true;
    if (lay === 'stacked100') { aCfg = Bc.merge(AV, { maxMode: 'auto' }); sopts.exactMax = hi > 0 ? 1 : 0; lo = Math.min(lo, 0); }
    if (lay === 'diverging' && cfg.diverging.symmetric) { var mm = Math.max(Math.abs(lo), Math.abs(hi)); lo = -mm; hi = mm; }
    var sc = scaleFor(lo, hi, aCfg, sopts);
    if (lay === 'stacked100' && lo < 0) sc = scaleFor(-1, 1, aCfg, { forceZero: true });
    if (lay === 'diverging' && cfg.diverging.symmetric) {
      var m2 = Math.max(Math.abs(sc.min), Math.abs(sc.max));
      sc = scaleFor(-m2, m2, Bc.merge(aCfg, { base: 'zero', maxMode: 'auto' }), {});
    }
    var span = sc.max - sc.min || 1;

    // ---- axis number formats ------------------------------------------------
    var af = cfg.format;
    if (lay === 'stacked100') af = Bc.merge(af, { scale: 'percent', pctFromRatio: true, decimals: 0, unit: '' });
    var tickText = tickTexts(sc.ticks, af, { abs: lay === 'diverging', exact: true });
    var vSize = AV.size;
    var tickThick = 0;
    if (AV.show) {
      tickThick = vert
        ? Math.max.apply(null, tickText.map(function (t) { return textWidth(t, vSize, AV.weight, AV.font); })) + 8
        : vSize + 8;
    }
    var vTitle = AV.show && AV.title ? AV.size + 8 : 0;

    // secondary line axis
    var lsc = null;
    var lTick = [];
    var lThick = 0;
    var LA = cfg.lineAxis;
    if (lines.length && !lineShared) {
      var llo = Infinity; var lhi = -Infinity;
      nodes.forEach(function (n) { lines.forEach(function (l) { var x = n.l[l.key]; if (isFinite(x)) { llo = Math.min(llo, x); lhi = Math.max(lhi, x); } }); });
      if (opts.extent && isFinite(opts.extent.llo)) { llo = Math.min(llo, opts.extent.llo); lhi = Math.max(lhi, opts.extent.lhi); }
      lsc = LA.sync ? sc : scaleFor(llo, lhi, Bc.merge(LA, { ticks: sc.ticks.length - 1 }), {});
      var lf = LA.useGlobalFormat ? cfg.format : LA.fmt;
      lTick = tickTexts(lsc.ticks, lf, { exact: LA.useGlobalFormat });
      if (LA.show) {
        lThick = vert ? Math.max.apply(null, lTick.map(function (t) { return textWidth(t, LA.size, 400, AV.font); })) + 8 : LA.size + 8;
        if (LA.title) lThick += LA.size + 6;
      }
    }

    // ---- reserves at the bar ends (outside labels, heads, icons, notes) -------
    var lblPad = badgePad(LB.badge, LB.size);
    var sampleTexts = [];
    nodes.forEach(function (n) { n.bars.forEach(function (b) { sampleTexts.push(labelText(v, b)); }); });
    if (stacked && LB.totals) nodes.forEach(function (n) { sampleTexts.push(totalText(v, n)); });
    var lblW = LB.show ? Math.max(0, Math.max.apply(null, sampleTexts.map(function (t) { return textWidth(t, LB.size, LB.weight, family); }).concat([0])) + lblPad.x * 2) : 0;
    var lblH = LB.show ? LB.size * 1.25 + lblPad.y * 2 : 0;
    if (LB.badge === 'circle' || LB.badge === 'ring' || LB.badge === 'hexagon' || LB.badge === 'diamond') { lblW = lblH = Math.max(lblW, lblH) * (LB.badge === 'diamond' ? 1.25 : 1); }
    var outsideLbl = LB.show && (LB.position === 'outsideEnd' || (LB.insideFallback && LB.position !== 'column')) && !(style === 'lollipop' && cfg.lollipop.valueInHead);
    var endRes = 4;
    if (outsideLbl) endRes += (vert ? lblH : lblW) + LB.offset;
    if (stacked && LB.show && LB.totals) endRes = Math.max(endRes, 4 + (vert ? LB.totalSize * 1.3 : lblW) + LB.offset);
    if (style === 'lollipop') {
      var hs = headSize(lblW, lblH);
      endRes += hs / 2;
      if (cfg.lollipop.valueInHead) endRes = Math.max(endRes, hs + 4);
    }
    if (IC.show && IC.placement === 'outside') endRes += iconBox() + IC.gap;
    if (AC.show && AC.placement === 'above') endRes += vert ? AC.size * 1.3 + 4 : maxCatLabelW(v) + 8;
    if (cfg.comments.show && Object.keys(cfg.comments.items).length) endRes += 6;
    var colRes = 0;
    if (LB.show && LB.position === 'column') colRes = (vert ? lblH : lblW) + 10;
    var hasNeg = lo < 0 && !(lay === 'diverging' && centerDiv);
    var negRes = hasNeg ? endRes : 4;
    var posRes = hi > 0 ? endRes + colRes : 4;
    if (lay === 'diverging') { negRes = endRes; posRes = endRes; }

    // ---- category label / icon / group sizes ---------------------------------
    var axisLabels = AC.show && (AC.placement === 'axis' || AC.placement === 'pill');
    var axisIcons = IC.show && IC.placement === 'axis';
    var runs = groupRuns(nodes);
    var showGroups = runs.some(function (r) { return r.grp; }) && G.mode !== 'none';
    var nGapRuns = 0;
    runs.forEach(function (r, i) { if (i > 0 && (r.grp || runs[i - 1].grp)) nGapRuns++; });
    var groupGapPx = showGroups ? Math.max(0, cfg.spacing.groupGap) : 0;

    var M = { l: 4, r: 4, t: 4, b: 4 }; // margins around the plot
    var catLabelThick = 0;
    var iconThick = axisIcons ? iconBox() + IC.gap + (IC.accent ? 6 : 0) : 0;
    var groupThick = 0;
    var catTitle = AC.show && AC.title ? AC.size + 8 : 0;
    var xl = []; // category label lines
    var slot;
    var Lc;

    if (vert) {
      // value axis left/right
      var vOnLeft = AV.position !== 'opposite';
      if (vOnLeft) { M.l += tickThick + vTitle; M.r += lThick; } else { M.r += tickThick + vTitle; M.l += lThick; }
      Lc = Math.max(10, W - M.l - M.r);
      slot = (Lc - nGapRuns * groupGapPx) / Math.max(1, N);
      if (axisLabels) {
        var lh = Math.round(AC.size * 1.25);
        if (AC.orientation === 'wrap') {
          xl = nodes.map(function (n) { return wrapText(n.label, Math.max(12, slot * 0.96), Math.max(1, AC.maxLines), AC.size, AC.weight, AC.font); });
          catLabelThick = Math.max.apply(null, xl.map(function (ls) { return ls.length; })) * lh + 6;
          if (AC.placement === 'pill') catLabelThick += 8;
        } else {
          var maxLen = Math.max(30, Math.min(H * 0.3, 160));
          xl = nodes.map(function (n) { return [ellipsize(n.label, maxLen, AC.size, AC.weight, AC.font)]; });
          var longest = Math.max.apply(null, xl.map(function (ls) { return textWidth(ls[0], AC.size, AC.weight, AC.font); }));
          catLabelThick = (AC.orientation === 'angled' ? longest * Math.SQRT1_2 + AC.size : longest) + 10;
        }
      }
      if (showGroups) groupThick = 8 + G.lineWidth + G.size + 6;
      var bottomStuff = catLabelThick + iconThick + groupThick + catTitle;
      if (centerDiv) bottomStuff = iconThick + groupThick + catTitle;
      if (AC.position === 'opposite') M.t += bottomStuff; else M.b += bottomStuff;
    } else {
      var vOnBottom = AV.position !== 'opposite';
      if (vOnBottom) { M.b += tickThick + vTitle; M.t += lThick; } else { M.t += tickThick + vTitle; M.b += lThick; }
      Lc = Math.max(10, H - M.t - M.b);
      slot = (Lc - nGapRuns * groupGapPx) / Math.max(1, N);
      if (axisLabels) {
        var maxW = AC.maxWidth > 0 ? AC.maxWidth : W * 0.36;
        var lw = Math.min(maxW, maxCatLabelW(v) + (AC.placement === 'pill' ? 16 : 0));
        catLabelThick = Math.ceil(lw) + 8;
        var lines2 = Math.max(1, Math.min(AC.maxLines, Math.floor(slot / (AC.size * 1.2)) || 1));
        xl = nodes.map(function (n) { return wrapText(n.label, lw - (AC.placement === 'pill' ? 16 : 0), lines2, AC.size, AC.weight, AC.font); });
      }
      if (showGroups) {
        var gw = Math.max.apply(null, runs.filter(function (r) { return r.grp; }).map(function (r) { return textWidth(r.grp.label, G.size, G.weight, family); }).concat([0]));
        groupThick = Math.min(W * 0.24, gw) + 10 + G.lineWidth + 6;
      }
      var leftStuff = (centerDiv ? 0 : catLabelThick) + iconThick + groupThick + catTitle;
      if (AC.position === 'opposite') M.r += leftStuff; else M.l += leftStuff;
    }

    var px0 = M.l; var px1 = W - M.r; var py0 = M.t; var py1 = H - M.b;
    if (px1 - px0 < 20 || py1 - py0 < 20) return;

    // ---- coordinate helpers ---------------------------------------------------
    // c: position along the category axis; value pixels along the other one.
    var cOrigin = vert ? px0 : py0;
    var vA = vert ? py1 : px0; // pixel of the low end
    var vB = vert ? py0 : px1; // pixel of the high end
    var vLo = vert ? vA - negRes : vA + negRes;
    var vHi = vert ? vB + posRes : vB - posRes;
    if (AV.reversed) { var tmp = vLo; vLo = vHi; vHi = tmp; }
    var cGap = 0;
    var centerL = 0; var centerR = 0;
    if (centerDiv) {
      cGap = catLabelThick;
      var mid = (vLo + vHi) / 2;
      var sgn = vHi > vLo ? 1 : -1;
      centerL = mid - sgn * cGap / 2;
      centerR = mid + sgn * cGap / 2;
    }
    function vpx (val) {
      if (centerDiv) {
        var m = Math.max(Math.abs(sc.min), Math.abs(sc.max)) || 1;
        return val < 0 ? centerL + (val / m) * (centerL - vLo) : centerR + (val / m) * (vHi - centerR);
      }
      return vLo + (val - sc.min) / span * (vHi - vLo);
    }
    function vpxc (val) { return vpx(Math.max(sc.min, Math.min(sc.max, val))); }
    function vbase (val) {
      if (centerDiv) return val < 0 ? centerL : centerR;
      return vpxc(0);
    }
    function XY (c, p) { return vert ? [c, p] : [p, c]; }

    // slot positions (with gaps between groups)
    var cStart = [];
    var acc = cOrigin;
    nodes.forEach(function (n, i) {
      if (i > 0 && showGroups && n.runStart && (n.run.grp || runs[n.run.i - 1].grp)) acc += groupGapPx;
      cStart.push(acc);
      acc += slot;
    });

    // bar widths
    var SP = cfg.spacing;
    var band = SP.widthMode === 'px' ? Math.min(slot, SP.px * (sideBySide ? K : 1) + (sideBySide ? (K - 1) * SP.seriesGap : 0)) : slot * Math.max(5, Math.min(100, SP.width)) / 100;
    var barW;
    var off = Math.max(0, Math.min(100, cfg.chart.overlapOffset)) / 100;
    if (sideBySide) barW = Math.max(1, (band - (K - 1) * SP.seriesGap) / K);
    else if (overlap) barW = Math.max(1, band / (1 + (K - 1) * off));
    else barW = SP.widthMode === 'px' ? Math.min(slot, SP.px) : band;
    if (sideBySide && SP.widthMode === 'px') barW = Math.min(SP.px, barW);

    function barSpan (i, b) {
      var cs = cStart[i];
      var bandStart = cs + (slot - band) / 2;
      if (sideBySide) {
        var used = K * barW + (K - 1) * SP.seriesGap;
        var st = cs + (slot - used) / 2 + b.si * (barW + SP.seriesGap);
        return [st, st + barW];
      }
      if (overlap) {
        var st2 = bandStart + b.si * barW * off;
        return [st2, st2 + barW];
      }
      var st3 = cs + (slot - barW) / 2;
      return [st3, st3 + barW];
    }

    // ---- layers ----------------------------------------------------------------
    var defs = node('defs');
    svg.appendChild(defs);
    var L = {};
    ['back', 'grid', 'track', 'bars', 'refs', 'targets', 'lines', 'axes', 'labels', 'icons', 'notes'].forEach(function (k) {
      L[k] = node('g', { class: 'layer-' + k });
      svg.appendChild(L[k]);
    });
    var SH = cfg.shadow;
    if (SH.show) {
      var f = node('filter', { id: 'bc-shadow', x: '-30%', y: '-30%', width: '160%', height: '160%' });
      f.appendChild(node('feDropShadow', { dx: SH.dx, dy: SH.dy, stdDeviation: Math.max(0, SH.blur) / 2, 'flood-color': SH.color, 'flood-opacity': Math.max(0, Math.min(100, SH.opacity)) / 100 }));
      defs.appendChild(f);
      L.bars.setAttribute('filter', 'url(#bc-shadow)');
    }

    var plotC0 = cOrigin;
    var plotC1 = cOrigin + Lc;
    var valueLine = function (p, g, attrs) {
      var a = XY(plotC0, p); var b = XY(plotC1, p);
      g.appendChild(node('line', Object.assign({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, attrs)));
    };

    // group bands
    if (showGroups && G.band) {
      runs.forEach(function (r) {
        if (!r.grp) return;
        var c0 = cStart[r.i0]; var c1 = cStart[r.i1] + slot;
        var x = vert ? c0 : px0; var y = vert ? py0 : c0;
        L.back.appendChild(node('rect', { x: x, y: y, width: vert ? c1 - c0 : px1 - px0, height: vert ? py1 - py0 : c1 - c0, fill: r.grp.color, 'fill-opacity': G.bandOpacity / 100 }));
      });
    }

    // value gridlines + ticks
    var LN = cfg.lines;
    sc.ticks.forEach(function (t, k) {
      var p = Math.round(vpx(t)) + 0.5;
      if (LN.valueGrid.show && !(t === 0 && LN.zero.show)) valueLine(p, L.grid, lineAttrs(LN.valueGrid));
      if (centerDiv && t !== 0) { var p2 = Math.round(vpx(-t)) + 0.5; if (LN.valueGrid.show) valueLine(p2, L.grid, lineAttrs(LN.valueGrid)); }
      if (AV.show) {
        var attrs = { 'font-size': vSize, 'font-weight': AV.weight, fill: AV.color, 'font-family': Bc.fontStack(AV.font) };
        var put = function (pp, txt) {
          if (vert) {
            var left = AV.position !== 'opposite';
            L.axes.appendChild(node('text', Object.assign({ x: left ? px0 - 6 : px1 + 6, y: pp + vSize * 0.35, 'text-anchor': left ? 'end' : 'start' }, attrs), txt));
          } else {
            var bottom = AV.position !== 'opposite';
            L.axes.appendChild(node('text', Object.assign({ x: pp, y: bottom ? py1 + vSize + 4 : py0 - 6, 'text-anchor': 'middle' }, attrs), txt));
          }
        };
        put(p, tickText[k]);
        if (centerDiv && t !== 0) put(Math.round(vpx(-t)) + 0.5, tickText[k]);
      }
    });
    if (AV.show && AV.title) {
      var tAttrs = { 'font-size': AV.size, 'font-weight': 600, fill: AV.color, 'font-family': Bc.fontStack(AV.font), 'text-anchor': 'middle' };
      if (vert) {
        var tx = AV.position !== 'opposite' ? AV.size : W - 4;
        var ty = (py0 + py1) / 2;
        L.axes.appendChild(node('text', Object.assign({ x: tx, y: ty, transform: 'rotate(-90 ' + tx + ' ' + ty + ')' }, tAttrs), AV.title));
      } else {
        L.axes.appendChild(node('text', Object.assign({ x: (px0 + px1) / 2, y: AV.position !== 'opposite' ? H - 3 : AV.size }, tAttrs), AV.title));
      }
    }
    if (AV.show && AV.showLine) {
      var ap = vert ? (AV.position !== 'opposite' ? px0 + 0.5 : px1 - 0.5) : (AV.position !== 'opposite' ? py1 - 0.5 : py0 + 0.5);
      L.axes.appendChild(node('line', vert ? { x1: ap, x2: ap, y1: py0, y2: py1, stroke: AV.lineColor, 'shape-rendering': 'crispEdges' } : { x1: px0, x2: px1, y1: ap, y2: ap, stroke: AV.lineColor, 'shape-rendering': 'crispEdges' }));
    }

    // category gridlines (between slots)
    if (LN.catGrid.show) {
      for (var gi = 1; gi < N; gi++) {
        var cp = Math.round(cStart[gi] - (cStart[gi] - cStart[gi - 1] - slot) / 2) + 0.5;
        var a1 = XY(cp, vert ? py0 : px0); var a2 = XY(cp, vert ? py1 : px1);
        L.grid.appendChild(node('line', Object.assign({ x1: a1[0], y1: a1[1], x2: a2[0], y2: a2[1] }, lineAttrs(LN.catGrid))));
      }
    }

    // zero line
    if (LN.zero.show && sc.min <= 0 && sc.max >= 0) {
      if (centerDiv) {
        valueLine(Math.round(centerL) + 0.5, L.grid, lineAttrs(LN.zero));
        valueLine(Math.round(centerR) + 0.5, L.grid, lineAttrs(LN.zero));
      } else {
        valueLine(Math.round(vpx(0)) + 0.5, L.axes, lineAttrs(LN.zero));
      }
    }

    // ---- bars ------------------------------------------------------------------
    var labels = []; // collision candidates
    var SHP = cfg.shape;
    var FL = cfg.fill;
    var BD = cfg.border;
    var eps = span * 1e-9;

    var orderBars = function (n) { return overlap ? n.bars.slice().reverse() : n.bars; };
    if (!showBars) nodes.forEach(function (n) { n.endItem = null; });
    else nodes.forEach(function (n, i) {
      var nodeEnd = null; // outermost end of this category (for notes / icons)
      var nodeItems = [];
      orderBars(n).forEach(function (b) {
        var cspan = barSpan(i, b);
        var c0 = cspan[0]; var c1 = cspan[1];
        var from = stacked ? b.from : 0;
        var to = stacked ? b.to : b.shown;
        var pb = stacked ? (centerDiv ? (from === 0 ? (to < 0 ? centerL : centerR) : vpx(from)) : vpxc(from)) : vbase(to);
        var pe = vpxc(to);
        var dirHint = (vHi > vLo ? 1 : -1) * (to < 0 ? -1 : 1);
        var F = frame(c0, c1, pb, pe, dirHint);
        var isLast = !stacked || (to >= 0 ? Math.abs(to - n.stackPos) < 1e-12 : Math.abs(to - n.stackNeg) < 1e-12);
        var isFirst = !stacked || from === 0;
        var g = node('g', { class: 'bar', 'data-i': drawn.length });
        L.bars.appendChild(g);
        var item = { node: n, b: b, kind: 'bar', c0: c0, c1: c1, pb: pb, pe: pe, F: F, i: i };
        drawn.push(item);
        g.setAttribute('data-k', 'c:' + rootLabel(n) + '|s:' + b.s.key);

        // radius / shape
        var rEnd = SHP.corners === 'none' ? 0 : SHP.endShape === 'pill' ? F.wid / 2 : SHP.endShape === 'flat' ? 0 : SHP.radius;
        var rBase = SHP.corners === 'all' ? rEnd : 0;
        if (!isLast) rEnd = 0;
        if (!isFirst) rBase = 0;
        var endShape = isLast ? SHP.endShape : 'flat';

        // progress track
        if (style === 'progress') {
          var tm = trackMax(n, b);
          var pt = vpxc(tm);
          var TF = frame(c0, c1, vbase(tm), pt, dirHint);
          var PR = cfg.progress;
          var trackD = barShape(TF, SHP.corners === 'none' ? 0 : (SHP.endShape === 'pill' ? TF.wid / 2 : SHP.radius), SHP.corners === 'all' || SHP.endShape === 'pill' ? (SHP.endShape === 'pill' ? TF.wid / 2 : SHP.radius) : 0, SHP.endShape === 'arrow' ? 'arrow' : 'rounded');
          var tr = node('path', { d: trackD, fill: PR.trackColor, 'fill-opacity': PR.trackOpacity / 100, class: 'track' });
          if (PR.trackBorder) { tr.setAttribute('stroke', PR.trackBorderColor); tr.setAttribute('stroke-width', 1); }
          L.track.appendChild(tr);
          if (PR.trackShadow) {
            var cid0 = 'bc-c' + (++uid);
            var cp0 = node('clipPath', { id: cid0 }); cp0.appendChild(node('path', { d: trackD })); defs.appendChild(cp0);
            var sh = frame(c0, c0 + F.wid * 0.22, vbase(tm), pt, dirHint);
            L.track.appendChild(node('path', { d: barShape(sh, 0, 0, 'flat'), fill: '#000', 'fill-opacity': 0.06, 'clip-path': 'url(#' + cid0 + ')' }));
          }
          item.track = { pt: pt, tm: tm };
          if (PR.showRemaining && tm > b.shown) {
            var rl = boxLabel(Bc.formatNumber(tm - b.shown, fmtOf(LB.fmt)), Math.max(8, LB.size - 1), 400, family, 'none');
            rl.fill = PR.remainingColor;
            rl.prio = 1;
            placeOn(rl, TF, 'insideEnd', LB.offset + 2);
            labels.push(rl);
          }
        }

        if (style === 'lollipop') {
          drawLollipop(g, n, b, F, c0, c1, item, defs);
        } else {
          drawBarBody(g, n, b, F, rBase, rEnd, endShape, item, defs, isLast);
        }

        // clipped bar marker
        var clipLow = (from === 0 ? 0 : from) < sc.min - eps && to > sc.min;
        var clipHigh = to > sc.max + eps || to < sc.min - eps && from > sc.min;
        if (cfg.brk.show && style !== 'progress' && (clipLow || (b.shown > 0 && sc.min > 0 && isFirst)) && F.len > 16) {
          drawBreak(g, F, F.len * Math.max(4, Math.min(90, cfg.brk.pos)) / 100, cfg.brk);
        } else if (cfg.brk.show && clipHigh && F.len > 16) {
          drawBreak(g, F, F.len * 0.85, cfg.brk);
        }

        // value label
        if (LB.show && wantLabel(v, n, b) && !(stacked && !LB.segments) && !(style === 'lollipop' && cfg.lollipop.valueInHead)) {
          var place = LB.position;
          if (stacked && (place === 'outsideEnd' || place === 'column') && (!isLast || LB.totals || lay === 'stacked100')) place = 'center';
          if (stacked && place === 'column') place = 'center';
          labels.push(barLabel(v, b, F, place, item, family, stacked && !isLast));
        }
        if (isLast) nodeEnd = { F: F, item: item };
        nodeItems.push({ F: F, item: item });
        // segments of the breakdown
        if (style === 'bar' && segSpec(n)) {
          drawSegments(g, n, b, F, item, defs, family, labels);
        }
      });

      // stacked totals
      if (stacked && LB.show && LB.totals && lay !== 'diverging') {
        ['pos', 'neg'].forEach(function (side) {
          var tot = side === 'pos' ? n.stackPos : n.stackNeg;
          if (!tot || (side === 'neg' && !n.stackNeg)) return;
          var cs = cStart[i] + (slot - barW) / 2;
          var F2 = frame(cs, cs + barW, vbase(tot), vpxc(tot), (vHi > vLo ? 1 : -1) * (tot < 0 ? -1 : 1));
          var txt = lay === 'stacked100' ? totalText(v, n) : Bc.formatNumber(side === 'pos' ? sumSide(n, 1) : sumSide(n, -1), fmtOf(LB.totalFmt));
          var lbl = boxLabel(txt, LB.totalSize, LB.totalWeight, family, 'none');
          lbl.fill = LB.totalColor;
          lbl.prio = 1e15;
          placeOn(lbl, F2, 'outsideEnd', LB.offset);
          labels.push(lbl);
        });
      }

      // icons inside / outside the bar
      // one icon per bar when each bar is a measure, else one per category (at the stack's end)
      if (IC.show && IC.placement !== 'axis' && nodeEnd) {
        var perBar = IC.by === 'measures' && v.visSeries.length > 1 && !stacked;
        (perBar ? nodeItems : [nodeEnd]).forEach(function (ne) {
          var F0 = ne.F;
          var isz = iconBox();
          var t;
          if (IC.placement === 'base') t = IC.gap + isz / 2;
          else if (IC.placement === 'middle') t = F0.len / 2;
          else if (IC.placement === 'end') t = F0.len - IC.gap - isz / 2;
          else t = F0.len + IC.gap + isz / 2;
          if (IC.placement === 'outside' || F0.len >= isz + IC.gap) {
            var pos = F0.P(t, F0.wid / 2);
            if (drawMemberIcon(L.icons, n, pos[0], pos[1], defs, ne.item.b.color, IC.placement === 'outside' ? 'out' : 'in', ne.item.b) && IC.placement === 'outside') ne.item.iconPad = isz + IC.gap;
          }
        });
      }
      n.endItem = nodeEnd && nodeEnd.item;
    });

    // ---- labels that follow the icons outside ------------------------------------
    labels.forEach(function (l) {
      if (l.item && l.item.iconPad && l.place === 'outsideEnd') shiftAlong(l, l.item.iconPad);
    });

    // ---- target markers --------------------------------------------------------------
    var TG = cfg.target;
    if (showBars && targetInfo() && !v.noTarget && !state.off['t:'] && TG.show && TG.style !== 'none' && lay !== 'stacked100') {
      nodes.forEach(function (n, i) {
        if (!isFinite(n.t)) return;
        var p = vpxc(n.t);
        var span2 = sideBySide || overlap ? [cStart[i] + (slot - band) / 2, cStart[i] + (slot + band) / 2] : barSpan(i, n.bars[0] || { si: 0 });
        var e = Math.max(0, TG.extend) * (span2[1] - span2[0]) / 100;
        var gT = node('g', { class: 'target' });
        labels.forEach(function (l) {
          if (!l.item || l.item.node !== n || l.place !== 'outsideEnd' || !l.F) return;
          var beyond = (p - l.item.pe) * (l.F.dir || 1);
          if (beyond > -TG.width) shiftAlong(l, Math.max(0, beyond) + TG.width + 1);
        });
        if (TG.style === 'line') {
          var a = XY(span2[0] - e, p); var b2 = XY(span2[1] + e, p);
          gT.appendChild(node('line', { x1: a[0], y1: a[1], x2: b2[0], y2: b2[1], stroke: TG.color, 'stroke-width': TG.width, 'stroke-linecap': 'round' }));
        } else if (TG.style === 'dot') {
          var cpt = XY((span2[0] + span2[1]) / 2, p);
          gT.appendChild(node('circle', { cx: cpt[0], cy: cpt[1], r: TG.width + 2.5, fill: '#fff', stroke: TG.color, 'stroke-width': TG.width }));
        } else {
          var tp = XY(span2[1] + 2, p);
          var sz = 4 + TG.width * 1.5;
          var pts = vert ? [[tp[0], tp[1]], [tp[0] + sz, tp[1] - sz * 0.7], [tp[0] + sz, tp[1] + sz * 0.7]] : [[tp[0], tp[1]], [tp[0] - sz * 0.7, tp[1] + sz], [tp[0] + sz * 0.7, tp[1] + sz]];
          gT.appendChild(node('polygon', { points: pts.map(function (q) { return q.join(','); }).join(' '), fill: TG.color }));
        }
        L.targets.appendChild(gT);
      });
    }

    // ---- reference lines -------------------------------------------------------------
    refVals.forEach(function (r) {
      var rc = r.cfg;
      var pa = vpxc(r.a);
      if (r.band) {
        var pbb = vpxc(r.b);
        var x0 = vert ? plotC0 : Math.min(pa, pbb);
        var y0 = vert ? Math.min(pa, pbb) : plotC0;
        L.refs.appendChild(node('rect', { x: x0, y: y0, width: vert ? plotC1 - plotC0 : Math.abs(pbb - pa), height: vert ? Math.abs(pbb - pa) : plotC1 - plotC0, fill: rc.color, 'fill-opacity': rc.bandOpacity / 100 }));
      }
      [r.a].concat(r.band ? [r.b] : []).forEach(function (val, j) {
        var pp = Math.round(vpxc(val)) + 0.5;
        valueLine(pp, L.refs, { stroke: rc.color, 'stroke-width': rc.width, 'stroke-dasharray': Bc.dashArray(rc.style, rc.width) });
        if (rc.label && j === 0) {
          var txt = rc.label.replace(/\{type\}/g, refName(rc)).replace(/\{value\}/g, Bc.formatNumber(val, fmtOf(LB.fmt)));
          var at = rc.labelPos === 'start' ? plotC0 + 2 : rc.labelPos === 'center' ? (plotC0 + plotC1) / 2 : plotC1 - 2;
          var anchor = rc.labelPos === 'start' ? 'start' : rc.labelPos === 'center' ? 'middle' : 'end';
          var q = vert ? [at, pp - 4] : [pp + 4, plotC0 + 10];
          if (!vert) anchor = 'start';
          var lbl = boxLabel(txt, Math.max(8, LB.size - 1), 600, family, 'none');
          lbl.fill = rc.color;
          lbl.prio = 1e16;
          lbl.x = anchor === 'end' ? q[0] - lbl.w / 2 : anchor === 'start' ? q[0] + lbl.w / 2 : q[0];
          lbl.y = vert ? q[1] - lbl.h / 2 + 2 : q[1];
          if (!vert) { lbl.x = q[0] + lbl.w / 2; lbl.y = plotC0 + lbl.h / 2; }
          labels.push(lbl);
        }
      });
    });

    // ---- line overlay -------------------------------------------------------------------
    if (lines.length) {
      var lpx = lineShared || !lsc ? vpx : function (val) { return vLo + (val - lsc.min) / ((lsc.max - lsc.min) || 1) * (vHi - vLo); };
      lines.forEach(function (l, li) {
        var lc = Bc.lineCfg(cfg, l.key);
        var col = lineColor(l.key, raw.lines.indexOf(l));
        var pts = [];
        nodes.forEach(function (n, i) {
          var val = n.l[l.key];
          if (!isFinite(val)) return;
          var c = cStart[i] + slot / 2;
          var p = lpx(val);
          var xy = XY(c, p);
          pts.push({ x: xy[0], y: xy[1], n: n, v: val, c: c, p: p });
        });
        if (!pts.length) return;
        var gl = node('g', { class: 'line-series', 'data-k': 'l:' + l.key, opacity: lc.opacity / 100 });
        L.lines.appendChild(gl);
        var d = linePath(pts, lc.curve, vert);
        if (lc.area) {
          var b0 = lpx(Math.max(lineShared || !lsc ? sc.min : lsc.min, 0));
          var first = pts[0]; var last = pts[pts.length - 1];
          var close = vert ? 'L' + last.x + ' ' + b0 + 'L' + first.x + ' ' + b0 + 'Z' : 'L' + b0 + ' ' + last.y + 'L' + b0 + ' ' + first.y + 'Z';
          gl.appendChild(node('path', { d: d + close, fill: col, 'fill-opacity': lc.areaOpacity / 100, stroke: 'none' }));
        }
        gl.appendChild(node('path', { d: d, fill: 'none', stroke: col, 'stroke-width': lc.width, 'stroke-dasharray': Bc.dashArray(lc.style, lc.width), 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        pts.forEach(function (q) {
          if (lc.marker !== 'none') gl.appendChild(markerShape(lc.marker, q.x, q.y, lc.markerSize, col, lc.markerFill === 'white' ? '#FFFFFF' : col, Math.max(1.2, lc.width * 0.75)));
          var hit = node('circle', { cx: q.x, cy: q.y, r: Math.max(7, lc.markerSize), fill: 'transparent', class: 'bar', 'data-i': drawn.length, 'data-k': 'l:' + l.key });
          gl.appendChild(hit);
          drawn.push({ node: q.n, kind: 'line', line: l, v: q.v, color: col, i: q.n.idx, x: q.x, y: q.y });
          if (lc.labels) {
            var lbl = boxLabel(Bc.formatNumber(q.v, fmtOf(lc.fmt)), lc.labelSize, lc.labelWeight, family, 'none');
            lbl.fill = col;
            lbl.prio = Math.abs(q.v) * 0.5;
            var dy = lc.markerSize / 2 + 3 + lbl.h / 2;
            if (lc.labelPos === 'right') { lbl.x = q.x + lc.markerSize / 2 + 3 + lbl.w / 2; lbl.y = q.y; } else { lbl.x = q.x; lbl.y = q.y + (lc.labelPos === 'below' ? dy : -dy); }
            labels.push(lbl);
          }
        });
        // line axis
        if (lsc && LA.show && li === 0 && !lineShared) {
          lsc.ticks.forEach(function (t, k) {
            var pp = lpx(t);
            if (vert) {
              var right = AV.position !== 'opposite';
              L.axes.appendChild(node('text', { x: right ? px1 + 6 : px0 - 6, y: pp + LA.size * 0.35, 'text-anchor': right ? 'start' : 'end', 'font-size': LA.size, fill: LA.color, 'font-family': Bc.fontStack(AV.font) }, lTick[k]));
            } else {
              L.axes.appendChild(node('text', { x: pp, y: AV.position !== 'opposite' ? py0 - 6 : py1 + LA.size + 4, 'text-anchor': 'middle', 'font-size': LA.size, fill: LA.color, 'font-family': Bc.fontStack(AV.font) }, lTick[k]));
            }
          });
          if (LA.title) {
            var lx = vert ? (AV.position !== 'opposite' ? W - 3 : LA.size) : (px0 + px1) / 2;
            var ly = vert ? (py0 + py1) / 2 : (AV.position !== 'opposite' ? LA.size : H - 3);
            L.axes.appendChild(node('text', { x: lx, y: ly, 'text-anchor': 'middle', 'font-size': LA.size, 'font-weight': 600, fill: LA.color, 'font-family': Bc.fontStack(AV.font), transform: vert ? 'rotate(' + (AV.position !== 'opposite' ? 90 : -90) + ' ' + lx + ' ' + ly + ')' : null }, LA.title));
          }
        }
      });
    }

    // ---- category axis -----------------------------------------------------------------
    var catEdge = vert ? (AC.position === 'opposite' ? py0 : py1) : (AC.position === 'opposite' ? px1 : px0);
    var outward = AC.position === 'opposite' ? -1 : 1; // vertical: +down; horizontal: -left
    if (AC.showLine) {
      var e0 = XY(plotC0, centerDiv ? 0 : catEdge); var e1 = XY(plotC1, catEdge);
      if (!centerDiv) {
        var lpos = Math.round(catEdge) + 0.5;
        L.axes.appendChild(node('line', vert ? { x1: px0, x2: px1, y1: lpos, y2: lpos, stroke: AC.lineColor, 'stroke-width': AC.lineWidth, 'shape-rendering': 'crispEdges' }
          : { x1: lpos, x2: lpos, y1: py0, y2: py1, stroke: AC.lineColor, 'stroke-width': AC.lineWidth, 'shape-rendering': 'crispEdges' }));
      }
      void e0; void e1;
    }
    var step = labelStep(nodes, slot, vert);
    var catFont = { 'font-size': AC.size, 'font-weight': AC.weight, 'font-family': Bc.fontStack(AC.font) };
    var catBody = function (n, i) {
      var cc = cStart[i] + slot / 2;
      var color = AC.colorByBar && n.bars[0] ? Bc.readable(n.bars[0].color) : AC.color;
      var barColor = n.bars[0] ? n.bars[0].color : AC.color;
      // axis icons
      var iconOff = 0;
      if (axisIcons) {
        var isz = iconBox();
        var ip = vert ? catEdge + outward * (IC.gap + isz / 2) : catEdge - (AC.position === 'opposite' ? -1 : 1) * (IC.gap + isz / 2 + (IC.accent ? 6 : 0));
        var xy = vert ? [cc, ip] : [ip, cc];
        if (drawMemberIcon(L.icons, n, xy[0], xy[1], defs, barColor, 'axis', n.bars[0]) && IC.accent) {
          var ax = vert ? [cc - isz / 2, catEdge + outward * 2, isz, 3] : [catEdge - (AC.position === 'opposite' ? -1 : 1) * 5 - 1.5, cc - isz / 2, 3, isz];
          L.icons.appendChild(node('rect', { x: ax[0], y: ax[1], width: ax[2], height: ax[3], rx: 1.5, fill: barColor }));
        }
        iconOff = isz + IC.gap + (IC.accent ? 6 : 0);
      }
      if (!AC.show) return;
      var item = n.endItem;
      if (AC.placement === 'axis' || AC.placement === 'pill') {
        if (i % step !== 0 && AC.hideLabelsAuto) return;
        var ls = xl[i] || [n.label];
        if (centerDiv) {
          var cpos = (centerL + centerR) / 2;
          var q = XY(cc, cpos);
          L.axes.appendChild(node('text', Object.assign({ x: q[0], y: q[1] + (vert ? 0 : AC.size * 0.35), 'text-anchor': 'middle', fill: color }, catFont), ellipsize(n.label, Math.abs(cGap) - 6, AC.size, AC.weight, AC.font)));
          return;
        }
        var lh2 = Math.round(AC.size * 1.25);
        if (AC.placement === 'pill') {
          var tw = Math.max.apply(null, ls.map(function (t) { return textWidth(t, AC.size, AC.weight, AC.font); }));
          var pw = Math.min(vert ? slot * 0.94 : catLabelThick - 6, tw + 16);
          var ph = ls.length * lh2 + 6;
          var px = vert ? cc - pw / 2 : catEdge - (AC.position === 'opposite' ? -1 : 1) * (iconOff + 4) - (AC.position === 'opposite' ? 0 : pw);
          var py = vert ? catEdge + outward * (iconOff + 6) - (outward < 0 ? ph : 0) : cc - ph / 2;
          L.axes.appendChild(node('rect', { x: px, y: py, width: pw, height: ph, rx: Math.min(AC.pillRadius, ph / 2), fill: barColor }));
          ls.forEach(function (t, k) {
            L.axes.appendChild(node('text', Object.assign({ x: px + pw / 2, y: py + 3 + AC.size + k * lh2 - 1, 'text-anchor': 'middle', fill: Bc.contrastText(barColor) }, catFont), t));
          });
          return;
        }
        if (vert) {
          var base = catEdge + outward * (iconOff + 6);
          if (AC.orientation === 'wrap') {
            ls.forEach(function (t, k) {
              var yy = outward > 0 ? base + AC.size + k * lh2 - 2 : base - (ls.length - 1 - k) * lh2 - 3;
              L.axes.appendChild(node('text', Object.assign({ x: cc, y: yy, 'text-anchor': 'middle', fill: color }, catFont), t));
            });
          } else {
            var ang = AC.orientation === 'angled' ? -45 : -90;
            var tx2 = cc + AC.size * 0.35;
            var ty2 = base + (outward > 0 ? 2 : -2);
            L.axes.appendChild(node('text', Object.assign({ x: tx2, y: ty2, 'text-anchor': outward > 0 ? 'end' : 'start', fill: color, transform: 'rotate(' + ang + ' ' + tx2 + ' ' + ty2 + ')' }, catFont), ls[0]));
          }
        } else {
          var left = AC.position !== 'opposite';
          var colW = catLabelThick - 8;
          var x0 = left ? catEdge - iconOff - 6 : catEdge + iconOff + 6;
          var anchor;
          var xx;
          if (AC.align === 'center') { anchor = 'middle'; xx = left ? x0 - colW / 2 : x0 + colW / 2; }
          else if (AC.align === 'start') { anchor = left ? 'start' : 'end'; xx = left ? x0 - colW : x0 + colW; }
          else { anchor = left ? 'end' : 'start'; xx = x0; }
          var y0 = cc - (ls.length - 1) * lh2 / 2 + AC.size * 0.35;
          ls.forEach(function (t, k) {
            L.axes.appendChild(node('text', Object.assign({ x: xx, y: y0 + k * lh2, 'text-anchor': anchor, fill: color }, catFont), t));
          });
        }
      } else if (item && (AC.placement === 'insideBase' || AC.placement === 'rotatedInside')) {
        var F1 = item.F;
        var col1 = Bc.contrastText(item.b.color);
        var rot = AC.placement === 'rotatedInside' && vert;
        var tw1 = textWidth(n.label, AC.size, AC.weight, AC.font);
        var avail = rot ? F1.len - 12 : (vert ? F1.wid - 6 : F1.len - 12);
        if (avail < 12) return;
        var t1 = ellipsize(n.label, avail, AC.size, AC.weight, AC.font);
        if (rot) {
          var p1 = F1.P(8, F1.wid / 2);
          L.labels.appendChild(node('text', Object.assign({ x: p1[0] + AC.size * 0.36, y: p1[1], fill: col1, 'text-anchor': 'start', transform: 'rotate(-90 ' + (p1[0] + AC.size * 0.36) + ' ' + p1[1] + ')' }, catFont), t1));
        } else if (vert) {
          var p2 = F1.P(8 + AC.size * 0.8, F1.wid / 2);
          L.labels.appendChild(node('text', Object.assign({ x: p2[0], y: p2[1], fill: col1, 'text-anchor': 'middle' }, catFont), t1));
        } else {
          var p3 = F1.P(8, F1.wid / 2);
          var right = item.pe >= item.pb;
          L.labels.appendChild(node('text', Object.assign({ x: p3[0], y: p3[1] + AC.size * 0.35, fill: col1, 'text-anchor': right ? 'start' : 'end' }, catFont), t1));
        }
        void tw1;
        // value labels placed at the base would collide with the name
        labels.forEach(function (l) { if (l.item === item && l.place === 'insideBase') l.hidden = true; });
      } else if (item && AC.placement === 'above') {
        var F2b = item.F;
        var lblExtra = 0;
        labels.forEach(function (l) { if (l.item === item && l.place === 'outsideEnd') lblExtra = Math.max(lblExtra, (vert ? l.h : l.w) + LB.offset); });
        var cl = boxLabel(n.label, AC.size, AC.weight, AC.font, 'none');
        cl.fill = color;
        cl.prio = 1e14;
        cl.item = item;
        placeOn(cl, F2b, 'outsideEnd', 4 + lblExtra + (item.iconPad || 0));
        labels.push(cl);
      }
    };
    // names on the axis are clickable like their bars (data-cat = index in catRefs, across panels)
    nodes.forEach(function (n, i) {
      var c0 = [L.axes, L.labels, L.icons].map(function (g) { return g.childNodes.length; });
      catBody(n, i);
      var ci = catRefs.push(n) - 1;
      [L.axes, L.labels, L.icons].forEach(function (g, k) {
        for (var j = c0[k]; j < g.childNodes.length; j++) g.childNodes[j].setAttribute('data-cat', ci);
      });
    });
    if (AC.show && AC.title) {
      var ct = { 'font-size': AC.size, 'font-weight': 700, fill: AC.color, 'font-family': Bc.fontStack(AC.font), 'text-anchor': 'middle' };
      if (vert) L.axes.appendChild(node('text', Object.assign({ x: (px0 + px1) / 2, y: AC.position === 'opposite' ? AC.size : H - 3 }, ct), AC.title));
      else {
        var cx2 = AC.position === 'opposite' ? W - 3 : AC.size; var cy2 = (py0 + py1) / 2;
        L.axes.appendChild(node('text', Object.assign({ x: cx2, y: cy2, transform: 'rotate(-90 ' + cx2 + ' ' + cy2 + ')' }, ct), AC.title));
      }
    }

    // ---- groups -------------------------------------------------------------------------
    if (showGroups) {
      var gf = fmtOf(G.fmt);
      runs.forEach(function (r) {
        if (!r.grp) return;
        var c0 = cStart[r.i0] + Math.min(6, slot * 0.15);
        var c1 = cStart[r.i1] + slot - Math.min(6, slot * 0.15);
        var txt = r.grp.label;
        if (G.showTotal) {
          var tot = 0;
          for (var q = r.i0; q <= r.i1; q++) tot += nodes[q].total;
          txt += G.separator + Bc.formatNumber(tot, gf);
        }
        var la = { stroke: r.grp.color, 'stroke-width': G.lineWidth, fill: 'none' };
        if (G.lineStyle === 'dashed' || G.lineStyle === 'dotted') la['stroke-dasharray'] = Bc.dashArray(G.lineStyle, G.lineWidth);
        var tAttrs2 = { 'font-size': G.size, 'font-weight': G.weight, fill: G.textColor, 'font-family': Bc.fontStack(family) };
        if (vert) {
          var gy = AC.position === 'opposite'
            ? py0 - catLabelThick - iconThick - 4
            : py1 + catLabelThick + iconThick + 4;
          var dirY = AC.position === 'opposite' ? -1 : 1;
          if (G.lineStyle === 'bracket') L.axes.appendChild(node('path', Object.assign({ d: 'M' + c0 + ' ' + (gy - dirY * 4) + 'V' + gy + 'H' + c1 + 'V' + (gy - dirY * 4) }, la)));
          else if (G.lineStyle !== 'none') L.axes.appendChild(node('line', Object.assign({ x1: c0, x2: c1, y1: gy, y2: gy }, la)));
          var ty3 = gy + dirY * (G.lineWidth / 2 + 3) + (dirY > 0 ? G.size : -2);
          L.axes.appendChild(node('text', Object.assign({ x: (c0 + c1) / 2, y: ty3, 'text-anchor': 'middle' }, tAttrs2), ellipsize(txt, Math.max(24, c1 - c0 + slot * 0.3), G.size, G.weight, family)));
        } else {
          var leftSide = AC.position !== 'opposite';
          var gx = leftSide ? px0 - catLabelThick - iconThick - 4 : px1 + catLabelThick + iconThick + 4;
          var dirX = leftSide ? -1 : 1;
          if (G.lineStyle === 'bracket') L.axes.appendChild(node('path', Object.assign({ d: 'M' + (gx - dirX * 4) + ' ' + c0 + 'H' + gx + 'V' + c1 + 'H' + (gx - dirX * 4) }, la)));
          else if (G.lineStyle !== 'none') L.axes.appendChild(node('line', Object.assign({ x1: gx, x2: gx, y1: c0, y2: c1 }, la)));
          var maxGW = groupThick - 10 - G.lineWidth;
          var gl2 = wrapText(txt, Math.max(20, maxGW), Math.max(1, Math.floor((c1 - c0) / (G.size * 1.2))), G.size, G.weight, family);
          var gy0 = (c0 + c1) / 2 - (gl2.length - 1) * G.size * 0.6 + G.size * 0.35;
          gl2.forEach(function (t, k) {
            L.axes.appendChild(node('text', Object.assign({ x: gx + dirX * (G.lineWidth / 2 + 5), y: gy0 + k * G.size * 1.2, 'text-anchor': leftSide ? 'end' : 'start' }, tAttrs2), t));
          });
        }
      });
    }

    // ---- comments --------------------------------------------------------------------------
    if (cfg.comments.show) drawComments(L.notes, nodes, labels, vert, family);

    // ---- label column (aligned at the plot edge) -----------------------------------------
    labels.forEach(function (l) {
      if (l.place !== 'column') return;
      var edge = vert ? py0 + 2 + l.h / 2 : px1 - 2 - l.w / 2;
      if (vert) l.y = edge; else l.x = edge;
    });

    resolveLabels(labels, W, H);
    labels.forEach(function (l) { if (!l.hidden) renderLabel(L.labels, l); });

    // remember geometry for hover effects
    v.geom = { vert: vert, px0: px0, px1: px1, py0: py0, py1: py1 };
    for (var di = firstItem; di < drawn.length; di++) drawn[di].v = v; // which panel / view each hit area is in

    // ---- grow animation ------------------------------------------------------------------
    if (animate) {
      Array.prototype.forEach.call(L.bars.querySelectorAll('.bar'), function (g) {
        var it = drawn[Number(g.getAttribute('data-i'))];
        if (!it || !it.F) return;
        var up = vert ? it.pe < it.pb : it.pe > it.pb;
        g.classList.add('grow');
        g.style.transformOrigin = vert ? (up ? '50% 100%' : '50% 0%') : (up ? '0% 50%' : '100% 50%');
        g.style.setProperty('--sx', vert ? '1' : '0');
        g.style.setProperty('--sy', vert ? '0' : '1');
      });
      [L.labels, L.lines, L.icons, L.notes, L.targets, L.track].forEach(function (g) { g.classList.add('fade'); });
    }

    // ------------------------------------------------------------------------------------
    // local drawing helpers (need the scale)
    // ------------------------------------------------------------------------------------
    function frame (c0, c1, b, e, dirHint) {
      var dir = e > b ? 1 : e < b ? -1 : (dirHint || 1) * (vert ? -1 : 1);
      var len = Math.abs(e - b);
      var wid = c1 - c0;
      return {
        len: len, wid: wid, dir: dir, c0: c0, c1: c1, b: b, e: e, vert: vert,
        P: vert
          ? function (t, s) { return [c0 + s, b + dir * t]; }
          : function (t, s) { return [b + dir * t, c0 + s]; }
      };
    }
    void frame;
  }

  // ---------------------------------------------------------------------------
  // Drawing helpers (geometry comes in a "frame": F.P(t, s) maps t along the
  // bar from its base and s across it to pixels, for either orientation)
  // ---------------------------------------------------------------------------
  function barShape (F, rEnd, rBase, endShape) {
    var len = F.len;
    var w = F.wid;
    var P = F.P;
    var pt = function (t, s, r) { var p = P(t, s); return [p[0], p[1], r || 0]; };
    if (len < 0.75) {
      // zero or tiny value: a hairline so the slot isn't empty
      return roundPoly([pt(-0.5, 0), pt(0.5, 0), pt(0.5, w), pt(-0.5, w)]);
    }
    if (endShape === 'arrow') {
      var d = Math.min(Math.max(2, cfg.shape.arrowDepth), len, w * 1.5);
      return roundPoly([pt(0, 0, rBase), pt(len - d, 0), pt(len, w / 2), pt(len - d, w), pt(0, w, rBase)]);
    }
    if (endShape === 'pill' && rEnd > 0 && len < rEnd + rBase) {
      // fully round even when the bar is shorter than it is wide: elliptical ends
      var we = Math.min(rEnd, w / 2);
      var wb = Math.min(rBase, w / 2);
      var le = len * rEnd / (rEnd + rBase);
      var lb = len - le;
      return roundPoly([pt(0, 0, [wb, lb]), pt(len, 0, [le, we]), pt(len, w, [we, le]), pt(0, w, [lb, wb])]);
    }
    var re = Math.max(0, Math.min(rEnd, w / 2, len));
    var rb = Math.max(0, Math.min(rBase, w / 2, Math.max(0, len - re)));
    return roundPoly([pt(0, 0, rb), pt(len, 0, re), pt(len, w, re), pt(0, w, rb)]);
  }

  function rectIn (F, t0, t1, s0, s1) {
    var a = F.P(t0, s0); var b = F.P(t1, s0); var c = F.P(t1, s1); var d = F.P(t0, s1);
    return 'M' + fx(a[0]) + ' ' + fx(a[1]) + 'L' + fx(b[0]) + ' ' + fx(b[1]) + 'L' + fx(c[0]) + ' ' + fx(c[1]) + 'L' + fx(d[0]) + ' ' + fx(d[1]) + 'Z';
  }

  function clipFor (defs, d) {
    var id = 'bc-c' + (++uid);
    var cp = node('clipPath', { id: id });
    cp.appendChild(node('path', { d: d }));
    defs.appendChild(cp);
    return 'url(#' + id + ')';
  }

  function paintFor (defs, F, color) {
    var FL = cfg.fill;
    if (FL.type !== 'gradient' || F.len < 1) return color;
    var id = 'bc-g' + (++uid);
    var a = FL.gradientDir === 'across' ? F.P(F.len / 2, 0) : F.P(0, F.wid / 2);
    var b = FL.gradientDir === 'across' ? F.P(F.len / 2, F.wid) : F.P(F.len, F.wid / 2);
    var g = node('linearGradient', { id: id, gradientUnits: 'userSpaceOnUse', x1: fx(a[0]), y1: fx(a[1]), x2: fx(b[0]), y2: fx(b[1]) });
    var other = FL.gradientTo === 'color' ? FL.gradientColor : Bc.tint(color, Math.max(0, Math.min(100, FL.gradientStrength)) / 100);
    g.appendChild(node('stop', { offset: '0', 'stop-color': other }));
    g.appendChild(node('stop', { offset: '1', 'stop-color': color }));
    defs.appendChild(g);
    return 'url(#' + id + ')';
  }

  function borderAttrs (color) {
    var B = cfg.border;
    if (!B.show) return {};
    var c = B.colorMode === 'bar' ? color : B.colorMode === 'custom' ? B.color : Bc.blend(color, -30);
    return { stroke: c, 'stroke-width': B.width, 'stroke-opacity': B.opacity / 100, 'stroke-dasharray': Bc.dashArray(B.style, B.width), 'stroke-linejoin': 'round' };
  }

  function drawBarBody (g, n, b, F, rBase, rEnd, endShape, item, defs) {
    var d = barShape(F, rEnd, rBase, endShape);
    item.d = d;
    var p = node('path', Object.assign({ class: 'bar-body', d: d, fill: paintFor(defs, F, b.color), 'fill-opacity': cfg.fill.opacity / 100 }, borderAttrs(b.color)));
    g.appendChild(p);
    if (cfg.fill.type === 'twoTone' && F.len > 1) {
      g.appendChild(node('path', { d: rectIn(F, 0, F.len, F.wid / 2, F.wid), fill: '#FFFFFF', 'fill-opacity': cfg.fill.twoTone / 100, 'clip-path': clipFor(defs, d), 'pointer-events': 'none' }));
    }
  }

  function headSize (lblW, lblH) {
    var LP = cfg.lollipop;
    return LP.valueInHead ? Math.max(LP.headSize, Math.max(lblW, lblH) + 6) : LP.head === 'none' ? 0 : LP.headSize;
  }

  function drawLollipop (g, n, b, F, c0, c1, item, defs) {
    var LP = cfg.lollipop;
    var sw = Math.max(1, Math.min(LP.stemWidth, F.wid));
    var s0 = F.wid / 2 - sw / 2;
    if (F.len > 0.5) {
      g.appendChild(node('path', { class: 'bar-body', d: rectIn(F, 0, F.len, s0, s0 + sw), fill: b.color, 'fill-opacity': LP.stemOpacity / 100 }));
    }
    // hit area as wide as the slot
    g.appendChild(node('path', { d: rectIn(F, 0, F.len + 4, 0, F.wid), fill: 'transparent' }));
    var txt = LP.valueInHead ? labelText(view, b) : '';
    var tw = txt ? textWidth(txt, cfg.labels.size, cfg.labels.weight, cfg.numbers.font) : 0;
    var hs = LP.valueInHead ? Math.max(LP.headSize, tw + 10, cfg.labels.size * 1.9) : LP.headSize;
    if (LP.head === 'none' && !LP.valueInHead) return;
    var c = F.P(F.len, F.wid / 2);
    var fill = LP.headFill === 'white' ? '#FFFFFF' : LP.headFill === 'custom' ? LP.headColor : b.color;
    var shape = LP.head === 'none' ? 'circle' : LP.head;
    var stroke = shape === 'ring' || LP.headFill !== 'bar' ? b.color : 'none';
    var el2 = markerShape(shape === 'ring' ? 'circle' : shape, c[0], c[1], hs, stroke, shape === 'ring' && LP.headFill === 'bar' ? '#FFFFFF' : fill, shape === 'ring' ? LP.ringWidth : (stroke !== 'none' ? 1.5 : 0));
    el2.setAttribute('class', 'bar-body');
    g.appendChild(el2);
    item.head = { x: c[0], y: c[1], r: hs / 2 };
    if (txt) {
      var tf = shape === 'ring' || fill === '#FFFFFF' ? Bc.readable(b.color) : Bc.contrastText(fill);
      g.appendChild(node('text', { x: c[0], y: c[1] + cfg.labels.size * 0.35, 'text-anchor': 'middle', 'font-size': cfg.labels.size, 'font-weight': cfg.labels.weight, fill: tf, 'font-family': Bc.fontStack(cfg.numbers.font) }, txt));
    }
  }

  /** Segments of a bar by the breakdown fields (Waterfall style). */
  function segDims (n) {
    var BD = cfg.breakdown;
    var keys = raw.dims.map(function (d) { return d.key; });
    var sel = (BD.dims || []).map(function (k) { return keys.indexOf(k); }).filter(function (i) { return i >= 0; });
    if (!sel.length) sel = keys.map(function (k, i) { return i; });
    // breakdown positions → field indices in the row (it.b is the full row)
    return sel.filter(function (i) { return i >= n.depth; }).map(function (i) { return raw.dimPos[i]; });
  }

  /**
   * How a bar is split: by the colour field when Colors → Dimensions (or
   * Highlight) uses a field deeper than the bar, else by the breakdown when
   * "Split bars into segments" is on. null = not split.
   */
  function segSpec (n) {
    var src = colorSegSource();
    var k = src ? deeperLevel(n, src) : -1;
    if (k >= 0) return { idx: [k], level: k, color: true };
    if (cfg.breakdown.show && raw.dims.length > n.depth) {
      var idx = segDims(n);
      if (idx.length) return { idx: idx, color: false };
    }
    return null;
  }

  function segmentsOf (n, sKey, spec) {
    var idx = spec ? spec.idx : segDims(n);
    if (!idx || !idx.length) return [];
    var BD = cfg.breakdown;
    var sums = {};
    var order = [];
    n.items.forEach(function (it) {
      if (it.s !== sKey) return;
      var name = idx.map(function (i) { return it.b[i]; }).join(BD.sep == null ? ' · ' : BD.sep);
      if (!(name in sums)) { sums[name] = 0; order.push(name); }
      sums[name] += it.v;
    });
    var segs = order.map(function (k) { return { member: k, v: sums[k] }; });
    return Bc.sortBy(segs, Bc.comparer(BD.order, function (x) { return x.v; }, function (x) { return x.member; }));
  }

  function segColors (segs, color, spec) {
    var BD = cfg.breakdown;
    var sh = Bc.shades(color, Math.max(1, segs.length));
    var map = {};
    var others = cfg.topN.label || 'Others';
    segs.forEach(function (s, i) {
      if (spec && spec.color) {
        if (s.member === others && cfg.topN.enabled) map[s.member] = cfg.topN.color;
        else if (view.cmode === 'highlight') map[s.member] = (cfg.colors.highlight || []).indexOf(s.member) >= 0 ? cfg.colors.highlightColor : cfg.colors.mutedColor;
        else map[s.member] = dimColor(spec.level, s.member);
        return;
      }
      map[s.member] = BD.colorMode === 'custom' && BD.colors[s.member] ? BD.colors[s.member] : sh[i];
    });
    return map;
  }

  function drawSegments (g, n, b, F, item, defs, family, labels) {
    var spec = segSpec(n);
    if (!spec) return;
    var segs = segmentsOf(n, b.s.key, spec);
    if (segs.length < (spec.color ? 1 : 2) || F.len < 1) return;
    var BD = cfg.breakdown;
    var tot = segs.reduce(function (a, s) { return a + Math.abs(s.v); }, 0) || 1;
    var colors = segColors(segs, b.color, spec);
    var sg = node('g', { 'clip-path': clipFor(defs, item.d || barShape(F, 0, 0, 'flat')) });
    g.appendChild(sg);
    var t = 0;
    item.segs = [];
    segs.forEach(function (s, k) {
      var len = F.len * Math.abs(s.v) / tot;
      var col = colors[s.member];
      sg.appendChild(node('path', { d: rectIn(F, t, t + len, 0, F.wid), fill: paintFor(defs, F, col), 'fill-opacity': cfg.fill.opacity / 100, 'data-seg': k }));
      if (BD.dividers && k < segs.length - 1) {
        var a = F.P(t + len, 0); var c = F.P(t + len, F.wid);
        sg.appendChild(node('line', { x1: a[0], y1: a[1], x2: c[0], y2: c[1], stroke: '#FFFFFF', 'stroke-width': 1 }));
      }
      item.segs.push({ seg: s, t0: t, t1: t + len, color: col });
      if (BD.showValues) {
        var txt = Bc.formatNumber(s.v, fmtOf(BD.fmt));
        if (BD.showNames) txt = s.member + ' ' + txt;
        var lbl = boxLabel(txt, BD.size, BD.weight, family, 'none');
        lbl.prio = Math.abs(s.v) * 0.9;
        var along = F.vert ? lbl.h : lbl.w;
        var across = F.vert ? lbl.w : lbl.h;
        var mid = t + len / 2;
        if (BD.position === 'inside') {
          if (len < Math.max(BD.minPx, along + 2) || across > F.wid + 2) return;
          var p = F.P(mid, F.wid / 2);
          lbl.x = p[0]; lbl.y = p[1];
          lbl.fill = BD.labelColorMode === 'custom' ? BD.labelColor : Bc.contrastText(col);
        } else {
          if (len < Math.max(2, BD.minPx * 0.5)) return;
          var right = BD.position === 'right';
          var sOff = right ? F.wid + 4 + across / 2 : -4 - across / 2;
          var p2 = F.P(mid, sOff);
          lbl.x = p2[0]; lbl.y = p2[1];
          lbl.fill = BD.labelColorMode === 'custom' ? BD.labelColor : Bc.readable(col);
        }
        labels.push(lbl);
      }
      t += len;
    });
  }

  /** "Bar continues" marker across a clipped bar, `t` px from its base. */
  function drawBreak (g, F, t, brk) {
    var x0 = -2; var x1 = F.wid + 2;
    var P = function (tt, s) { return F.P(tt, s).map(fx).join(','); };
    if (brk.style === 'zigzag') {
      var teeth = Math.max(2, Math.round((x1 - x0) / 7));
      var tw = (x1 - x0) / teeth;
      var top = []; var bot = [];
      for (var k = 0; k <= teeth; k++) {
        var s = x0 + k * tw;
        var dt = k % 2 ? -2.5 : 2.5;
        top.push(P(t - 4 + dt, s)); bot.push(P(t + 4 + dt, s));
      }
      g.appendChild(node('polygon', { points: top.concat(bot.slice().reverse()).join(' '), fill: brk.bandColor }));
      g.appendChild(node('polyline', { points: top.join(' '), fill: 'none', stroke: brk.lineColor, 'stroke-width': 1 }));
      g.appendChild(node('polyline', { points: bot.join(' '), fill: 'none', stroke: brk.lineColor, 'stroke-width': 1 }));
      return;
    }
    var tilt = brk.style === 'slash' ? 3 : 0;
    g.appendChild(node('polygon', { points: [P(t - 4, x0), P(t - 4 + tilt, x1), P(t + 4 + tilt, x1), P(t + 4, x0)].join(' '), fill: brk.bandColor }));
    if (brk.style === 'slash') {
      g.appendChild(node('polyline', { points: [P(t - 4, x0), P(t - 4 + tilt, x1)].join(' '), stroke: brk.lineColor, 'stroke-width': 1, fill: 'none' }));
      g.appendChild(node('polyline', { points: [P(t + 4, x0), P(t + 4 + tilt, x1)].join(' '), stroke: brk.lineColor, 'stroke-width': 1, fill: 'none' }));
    }
  }

  function markerShape (type, x, y, size, stroke, fill, sw) {
    var r = size / 2;
    var attrs = { fill: fill, stroke: stroke && stroke !== 'none' ? stroke : null, 'stroke-width': stroke && stroke !== 'none' ? sw : null };
    if (type === 'square') return node('rect', Object.assign({ x: x - r, y: y - r, width: size, height: size, rx: Math.min(2, r / 3) }, attrs));
    if (type === 'diamond') return node('polygon', Object.assign({ points: [[x, y - r * 1.2], [x + r * 1.2, y], [x, y + r * 1.2], [x - r * 1.2, y]].map(function (p) { return p.map(fx).join(','); }).join(' ') }, attrs));
    if (type === 'hexagon') {
      var pts = [];
      for (var i = 0; i < 6; i++) { var a = Math.PI / 3 * i - Math.PI / 2; pts.push(fx(x + r * 1.08 * Math.cos(a)) + ',' + fx(y + r * 1.08 * Math.sin(a))); }
      return node('polygon', Object.assign({ points: pts.join(' ') }, attrs));
    }
    if (type === 'ring') return node('circle', Object.assign({ cx: x, cy: y, r: r }, attrs, { fill: '#FFFFFF', stroke: stroke || fill, 'stroke-width': Math.max(1.5, sw) }));
    return node('circle', Object.assign({ cx: x, cy: y, r: r }, attrs));
  }

  function linePath (pts, curve, vert) {
    if (pts.length === 1) return 'M' + pts[0].x + ' ' + pts[0].y;
    var d = 'M' + fx(pts[0].x) + ' ' + fx(pts[0].y);
    if (curve === 'step') {
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i - 1]; var b = pts[i];
        if (vert) { var mx = (a.x + b.x) / 2; d += 'H' + fx(mx) + 'V' + fx(b.y) + 'H' + fx(b.x); } else { var my = (a.y + b.y) / 2; d += 'V' + fx(my) + 'H' + fx(b.x) + 'V' + fx(b.y); }
      }
      return d;
    }
    if (curve === 'smooth') {
      for (var j = 0; j < pts.length - 1; j++) {
        var p0 = pts[Math.max(0, j - 1)]; var p1 = pts[j]; var p2 = pts[j + 1]; var p3 = pts[Math.min(pts.length - 1, j + 2)];
        var t = 0.18;
        d += 'C' + fx(p1.x + (p2.x - p0.x) * t) + ' ' + fx(p1.y + (p2.y - p0.y) * t) + ' ' + fx(p2.x - (p3.x - p1.x) * t) + ' ' + fx(p2.y - (p3.y - p1.y) * t) + ' ' + fx(p2.x) + ' ' + fx(p2.y);
      }
      return d;
    }
    for (var k = 1; k < pts.length; k++) d += 'L' + fx(pts[k].x) + ' ' + fx(pts[k].y);
    return d;
  }

  // ---------------------------------------------------------------------------
  // Icons for dimension members
  // ---------------------------------------------------------------------------
  function iconBox () {
    var IC = cfg.icons;
    return IC.bg !== 'none' ? Math.round(IC.size * 1.55) : IC.size;
  }

  function iconSpec (n, b) {
    var IC = cfg.icons;
    var mem = memberOf(n, b, IC.by || 'auto');
    var spec = mem != null ? IC.members[mem] : null;
    if (!spec && IC.fallback) spec = { source: 'builtin', builtinId: IC.fallback };
    if (!spec || (spec.source !== 'builtin' && !spec.dataUrl)) return null;
    return spec;
  }

  /** Draws a member's icon centred at (x, y). kind: axis | in (on the bar) | out. */
  function drawMemberIcon (g, n, x, y, defs, barColor, kind, b) {
    var IC = cfg.icons;
    var spec = iconSpec(n, b);
    if (!spec) return false;
    var size = IC.size;
    var box = iconBox();
    var gi = node('g', { class: 'member-icon' });
    g.appendChild(gi);
    var bgFill = null;
    if (IC.bg !== 'none') {
      bgFill = IC.bgMode === 'bar' ? barColor : IC.bgMode === 'tint' ? Bc.tint(barColor, 0.82) : IC.bgColor;
      var bga = { fill: bgFill };
      if (IC.bg === 'circle') gi.appendChild(node('circle', Object.assign({ cx: x, cy: y, r: box / 2 }, bga)));
      else gi.appendChild(node('rect', Object.assign({ x: x - box / 2, y: y - box / 2, width: box, height: box, rx: IC.bg === 'rounded' ? box * 0.24 : 2 }, bga)));
    }
    var builtin = spec.source === 'builtin';
    var icon = builtin ? Bc.findIcon(spec.builtinId) : null;
    var src = builtin ? icon.src : spec.dataUrl;
    if (!src) return false;
    var tintColor;
    var mode = IC.tint;
    if (mode === 'original' || (mode === 'auto' && !builtin)) tintColor = null;
    else if (mode === 'white') tintColor = '#FFFFFF';
    else if (mode === 'custom') tintColor = IC.color;
    else if (mode === 'bar') tintColor = barColor;
    else tintColor = bgFill ? Bc.contrastText(bgFill) : kind === 'in' ? Bc.contrastText(barColor) : barColor;
    if (builtin && !icon.tint) tintColor = null;
    var dims = { x: x - size / 2, y: y - size / 2, width: size, height: size };
    var img = node('image', Object.assign({ preserveAspectRatio: 'xMidYMid meet' }, dims));
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', src);
    img.setAttribute('href', src);
    if (tintColor) {
      var id = 'bc-m' + (++uid);
      var m = node('mask', Object.assign({ id: id, maskUnits: 'userSpaceOnUse', style: 'mask-type:alpha' }, dims));
      m.appendChild(img);
      defs.appendChild(m);
      gi.appendChild(node('rect', Object.assign({ fill: tintColor, mask: 'url(#' + id + ')' }, dims)));
    } else {
      gi.appendChild(img);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Labels: text, placement, collisions
  // ---------------------------------------------------------------------------
  function badgePad (badge, size) {
    switch (badge) {
      case 'pill': case 'rounded': case 'tag': return { x: size * 0.6, y: size * 0.28 };
      case 'circle': case 'ring': case 'hexagon': return { x: size * 0.45, y: size * 0.45 };
      case 'diamond': return { x: size * 0.55, y: size * 0.55 };
      default: return { x: 0, y: 0 };
    }
  }

  function boxLabel (text, size, weight, family, badge) {
    var pad = badgePad(badge, size);
    var w = textWidth(text, size, weight, family) + pad.x * 2;
    var h = size * 1.25 + pad.y * 2;
    if (badge === 'circle' || badge === 'ring' || badge === 'hexagon' || badge === 'diamond') { w = h = Math.max(w, h); }
    return { text: String(text), size: size, weight: weight, family: family, badge: badge || 'none', w: w, h: h, x: 0, y: 0, prio: 0 };
  }

  /** Places a label on a bar frame: outsideEnd | insideEnd | center | insideBase | column. */
  function placeOn (lbl, F, place, off) {
    var along = F.vert ? lbl.h : lbl.w;
    var t;
    if (place === 'insideEnd') t = F.len - off - along / 2;
    else if (place === 'insideBase') t = off + along / 2;
    else if (place === 'center') t = F.len / 2;
    else t = F.len + off + along / 2;
    var p = F.P(t, F.wid / 2);
    lbl.x = p[0]; lbl.y = p[1];
    lbl.F = F; lbl.t = t; lbl.place = place;
    return lbl;
  }

  function shiftAlong (l, d) {
    if (!l.F) return;
    l.t += d;
    var p = l.F.P(l.t, l.F.wid / 2);
    l.x = p[0]; l.y = p[1];
  }

  function pctFmt (f) { return Bc.merge(f, { scale: 'percent', pctFromRatio: true, unit: '' }); }

  function labelText (v, b) {
    var LB = cfg.labels;
    var f = fmtOf(LB.fmt);
    var n = b.node;
    var value = function () { return Bc.formatNumber(b.v, f, { fv: b.count === 1 ? b.fv : null, signed: true }); };
    var catSum = n.bars.reduce(function (a, x) { return a + Math.abs(x.v); }, 0) || 1;
    var tot = v.totalsBySeries[b.s.key] || 1;
    switch (LB.content) {
      case 'pctTotal': return Bc.formatNumber(b.v / tot, pctFmt(f));
      case 'pctCat': return Bc.formatNumber(b.v / catSum, pctFmt(f));
      case 'valuePct': return value() + ' (' + Bc.formatNumber(v.visSeries.length > 1 ? b.v / catSum : b.v / tot, pctFmt(f)) + ')';
      case 'diffPrev': return b.prev ? Bc.formatNumber(b.v - b.prev.v, Bc.merge(f, { plusSign: true }), { signed: true }) : '';
      case 'pctDiffPrev': return b.prev && b.prev.v ? Bc.formatNumber((b.v - b.prev.v) / Math.abs(b.prev.v), Bc.merge(pctFmt(f), { plusSign: true }), { signed: true }) : '';
      case 'rank': return '#' + rankOf(v, b);
      case 'nameValue': return n.label + ': ' + value();
      default: return value();
    }
  }

  function rankOf (v, b) {
    var vals = v.nodes.map(function (n) { var x = n.bars.find(function (y) { return y.s.key === b.s.key; }); return x ? x.v : -Infinity; });
    vals.sort(function (a, c) { return c - a; });
    return vals.indexOf(b.v) + 1;
  }

  function sumSide (n, sign) {
    return n.bars.reduce(function (a, b) { return a + ((b.shown >= 0) === (sign > 0) ? b.v : 0); }, 0);
  }

  function totalText (v, n) {
    return Bc.formatNumber(n.bars.reduce(function (a, b) { return a + b.v; }, 0), fmtOf(cfg.labels.totalFmt));
  }

  function wantLabel (v, n, b) {
    var w = cfg.labels.which;
    if (w === 'all') return true;
    if (!v._which) {
      v._which = {};
      v.visSeries.forEach(function (s) {
        var bars = [];
        v.nodes.forEach(function (x) { x.bars.forEach(function (y) { if (y.s.key === s.key) bars.push(y); }); });
        if (!bars.length) return;
        var mn = bars[0]; var mx = bars[0];
        bars.forEach(function (y) { if (y.v < mn.v) mn = y; if (y.v > mx.v) mx = y; });
        v._which[s.key] = { min: mn, max: mx, first: bars[0], last: bars[bars.length - 1] };
      });
    }
    var o = v._which[b.s.key];
    if (!o) return false;
    if (w === 'minmax') return b === o.min || b === o.max;
    return b === o[w];
  }

  function barLabel (v, b, F, place, item, family, inner) {
    var LB = cfg.labels;
    var text = labelText(v, b);
    var lbl = boxLabel(text, LB.size, LB.weight, family, LB.badge);
    lbl.italic = LB.italic;
    lbl.prio = Math.abs(b.v);
    lbl.item = item;
    lbl.barColor = b.color;
    lbl.key = 'c:' + rootLabel(b.node) + '|s:' + b.s.key;
    if (!text) { lbl.hidden = true; return lbl; }
    var off = LB.offset;
    if (v.style === 'lollipop' && (place === 'outsideEnd')) off += headSize(0, 0) / 2;
    var along = F.vert ? lbl.h : lbl.w;
    var across = F.vert ? lbl.w : lbl.h;
    var inside = place === 'insideEnd' || place === 'insideBase' || place === 'center';
    if (inside && v.style === 'lollipop') { place = 'outsideEnd'; inside = false; off += headSize(0, 0) / 2; }
    if (inside && (along + 2 * Math.min(off, 4) > F.len || across > F.wid + 4)) {
      if (LB.insideFallback && !inner) { place = 'outsideEnd'; inside = false; } else { lbl.hidden = true; }
    }
    placeOn(lbl, F, place, off);
    var badgeFill = LB.badge === 'none' ? null : LB.badgeFill === 'white' ? '#FFFFFF' : LB.badgeFill === 'custom' ? LB.badgeColor : b.color;
    lbl.bgFill = badgeFill;
    lbl.bgStroke = badgeFill && (LB.badgeBorder || LB.badge === 'ring') ? (LB.badgeFill === 'bar' ? Bc.blend(b.color, -18) : b.color) : null;
    if (LB.badge === 'ring') { lbl.bgFill = '#FFFFFF'; lbl.bgStroke = b.color; }
    var m = LB.colorMode;
    if (lbl.bgFill) lbl.fill = m === 'custom' ? LB.color : m === 'blend' ? Bc.blend(b.color, LB.blend) : (lbl.bgFill === '#FFFFFF' ? Bc.readable(b.color) : Bc.contrastText(lbl.bgFill));
    else if (m === 'bar') lbl.fill = b.color;
    else if (m === 'blend') lbl.fill = Bc.blend(b.color, LB.blend);
    else if (m === 'custom') lbl.fill = LB.color;
    else lbl.fill = inside && v.style !== 'progress' ? Bc.contrastText(b.color) : inside ? Bc.contrastText(b.color) : Bc.readable(b.color);
    if (inside && v.style === 'progress' && place === 'insideBase') lbl.fill = m === 'auto' ? Bc.contrastText(b.color) : lbl.fill;
    return lbl;
  }

  function resolveLabels (labels, W, H) {
    var mode = cfg.labels.overlap;
    var placed = [];
    var list = labels.filter(function (l) { return !l.hidden; });
    list.sort(function (a, b) { return (b.prio || 0) - (a.prio || 0); });
    var scales = mode === 'shrink' ? [1, 0.86, 0.74] : [1];
    list.forEach(function (l) {
      var ok = false;
      for (var i = 0; i < scales.length && !ok; i++) {
        var s = scales[i];
        var box = { x0: l.x - l.w * s / 2 - 1, x1: l.x + l.w * s / 2 + 1, y0: l.y - l.h * s / 2 - 1, y1: l.y + l.h * s / 2 + 1 };
        var inBounds = box.x0 >= -4 && box.x1 <= W + 4 && box.y0 >= -4 && box.y1 <= H + 4;
        var clash = mode !== 'none' && placed.some(function (p) { return box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0; });
        if (inBounds && !clash) { ok = true; l.scale = s; placed.push(box); }
      }
      if (!ok) l.hidden = true;
    });
  }

  function renderLabel (g, l) {
    var gl = node('g', { class: 'lbl', 'data-k': l.key || '' });
    // value labels are clickable like their bar
    var li = l.item ? drawn.indexOf(l.item) : -1;
    if (li >= 0) gl.setAttribute('data-i', li);
    if (l.scale && l.scale !== 1) gl.setAttribute('transform', 'translate(' + fx(l.x) + ' ' + fx(l.y) + ') scale(' + l.scale + ') translate(' + fx(-l.x) + ' ' + fx(-l.y) + ')');
    var x = l.x; var y = l.y; var w = l.w; var h = l.h;
    if (l.bgFill) {
      var a = { fill: l.bgFill, stroke: l.bgStroke || null, 'stroke-width': l.bgStroke ? (l.badge === 'ring' ? 2.5 : 1.2) : null };
      var r = Math.max(w, h) / 2;
      switch (l.badge) {
        case 'circle': case 'ring': gl.appendChild(node('circle', Object.assign({ cx: x, cy: y, r: r }, a))); break;
        case 'hexagon': gl.appendChild(markerShape('hexagon', x, y, r * 2, a.stroke, a.fill, a['stroke-width'] || 0)); break;
        case 'diamond': gl.appendChild(markerShape('diamond', x, y, r * 1.7, a.stroke, a.fill, a['stroke-width'] || 0)); break;
        case 'pill': gl.appendChild(node('rect', Object.assign({ x: x - w / 2, y: y - h / 2, width: w, height: h, rx: h / 2 }, a))); break;
        case 'tag': {
          gl.appendChild(node('rect', Object.assign({ x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 3 }, a)));
          if (l.F) {
            var base = l.F.P(l.t - (l.F.vert ? h : w) / 2 - 4, l.F.wid / 2);
            var c1 = l.F.P(l.t - (l.F.vert ? h : w) / 2 + 0.5, l.F.wid / 2 - 4);
            var c2 = l.F.P(l.t - (l.F.vert ? h : w) / 2 + 0.5, l.F.wid / 2 + 4);
            gl.appendChild(node('polygon', { points: [base, c1, c2].map(function (p) { return p.map(fx).join(','); }).join(' '), fill: l.bgFill }));
          }
          break;
        }
        default: gl.appendChild(node('rect', Object.assign({ x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 4 }, a)));
      }
    }
    gl.appendChild(node('text', {
      x: fx(x), y: fx(y + l.size * 0.35), 'text-anchor': 'middle', 'font-size': l.size, 'font-weight': l.weight,
      'font-style': l.italic ? 'italic' : null, fill: l.fill || '#17202B', 'font-family': Bc.fontStack(l.family)
    }, l.text));
    g.appendChild(gl);
  }

  // ---------------------------------------------------------------------------
  // Misc helpers used by drawChart
  // ---------------------------------------------------------------------------
  function rootLabel (n) { while (n.parent) n = n.parent; return n.label; }

  function maxCatLabelW (v) {
    var AC = cfg.axisC;
    return Math.max.apply(null, v.nodes.map(function (n) { return textWidth(n.label, AC.size, AC.weight, AC.font); }).concat([10]));
  }

  function groupRuns (nodes) {
    var runs = [];
    var cur = null;
    nodes.forEach(function (n, i) {
      var id = n.grp ? n.grp.id : null;
      if (!cur || cur.id !== id) {
        cur = { id: id, grp: n.grp, i0: i, i1: i, i: runs.length };
        runs.push(cur);
        n.runStart = true;
      } else {
        cur.i1 = i;
        n.runStart = false;
      }
      n.run = cur;
    });
    return runs;
  }

  function labelStep (nodes, slot, vert) {
    var AC = cfg.axisC;
    if (!AC.hideLabelsAuto || !(slot > 0)) return 1;
    if (vert) {
      var need = AC.orientation === 'wrap' ? AC.size * 2.4 : AC.size * 1.3;
      return Math.max(1, Math.ceil(need / slot));
    }
    return Math.max(1, Math.ceil(AC.size * 1.15 / slot));
  }

  /** Progress bars: the value each bar fills up to. */
  function progressMaxFn (v) {
    var PR = cfg.progress;
    var maxV = 0;
    var inUnit = true;
    v.nodes.forEach(function (n) { n.bars.forEach(function (b) { maxV = Math.max(maxV, b.shown); if (Math.abs(b.shown) > 1.0001) inUnit = false; }); });
    var mode = PR.max;
    var f = cfg.format;
    if (mode === 'auto') mode = inUnit ? 'one' : (maxV <= 100 && /percent/.test(f.scale) && !f.pctFromRatio) ? 'hundred' : 'max';
    if (mode === 'percent') mode = inUnit ? 'one' : 'hundred';
    return function (n) {
      switch (mode) {
        case 'one': return 1;
        case 'hundred': return 100;
        case 'target': return isFinite(n.t) && n.t > 0 ? n.t : maxV;
        case 'fixed': return Number(PR.fixed) || maxV;
        default: return maxV;
      }
    };
  }

  function refValues (v) {
    var out = [];
    (cfg.refs || []).forEach(function (r0, ri) {
      var r = Bc.refCfg(r0);
      if (!r.show || state.off['r:' + ri]) return;
      var vals = [];
      v.nodes.forEach(function (n) {
        if (v.layout === 'stacked' || v.layout === 'stacked100') { vals.push(n.stackPos + n.stackNeg); return; }
        n.bars.forEach(function (b) {
          if (r.scope && r.scope.indexOf('series:') === 0 && 'series:' + b.s.key !== r.scope) return;
          vals.push(b.shown);
        });
      });
      var a = refCalc(r.type, vals, r);
      if (!isFinite(a)) return;
      var b = r.bandTo ? refCalc(r.bandTo, vals, r) : a;
      out.push({ cfg: r, a: a, b: isFinite(b) ? b : a, band: !!r.bandTo && isFinite(b) });
    });
    return out;
  }

  function refCalc (type, vals, r) {
    if (type === 'constant') return Number(r.value);
    if (!vals.length) return NaN;
    var s = vals.slice().sort(function (a, b) { return a - b; });
    var sum = s.reduce(function (a, b) { return a + b; }, 0);
    var q = function (p) { var i = (s.length - 1) * p; var lo = Math.floor(i); var hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
    switch (type) {
      case 'average': return sum / s.length;
      case 'median': return q(0.5);
      case 'min': return s[0];
      case 'max': return s[s.length - 1];
      case 'percentile': return q(Math.max(0, Math.min(100, r.percentile)) / 100);
      case 'total': return sum;
      default: return NaN;
    }
  }

  // ---------------------------------------------------------------------------
  // Comments on bars
  // ---------------------------------------------------------------------------
  function commentsOf (n) { return (cfg.comments.items && cfg.comments.items[n.key]) || []; }

  function drawComments (g, nodes, labels, vert, family) {
    var C = cfg.comments;
    nodes.forEach(function (n) {
      var list = commentsOf(n);
      if (!list.length || !n.endItem) return;
      var it = n.endItem;
      var F = it.F;
      var color = list[list.length - 1].color || C.color;
      var p = F.P(F.len, F.wid);
      var gm = node('g', { class: 'comment-mark bar', 'data-i': drawn.length });
      drawn.push({ node: n, kind: 'comment', b: it.b, F: F });
      var x = p[0]; var y = p[1];
      var count = list.length > 1 ? String(list.length) : '';
      if (C.marker === 'flag') {
        gm.appendChild(node('path', { d: 'M' + x + ' ' + y + 'v-16', stroke: color, 'stroke-width': 1.5 }));
        gm.appendChild(node('path', { d: 'M' + x + ' ' + (y - 16) + 'h10l-3 4 3 4h-10z', fill: color }));
      } else if (C.marker === 'pin') {
        gm.appendChild(node('path', { d: 'M' + x + ' ' + y + 'c-5 -6 -7 -9 -7 -12a7 7 0 1 1 14 0c0 3 -2 6 -7 12z', fill: color }));
        gm.appendChild(node('circle', { cx: x, cy: y - 12, r: 2.6, fill: '#fff' }));
      } else if (C.marker === 'bubble') {
        gm.appendChild(node('path', { d: 'M' + (x - 8) + ' ' + (y - 20) + 'h16a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-9l-4 4v-4h-3a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3z', fill: color }));
        gm.appendChild(node('text', { x: x, y: y - 11, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#fff', 'font-family': Bc.fontStack(family) }, count || '…'));
      } else {
        gm.appendChild(node('circle', { cx: x, cy: y, r: count ? 6.5 : 5, fill: color, stroke: '#fff', 'stroke-width': 1.5 }));
        if (count) gm.appendChild(node('text', { x: x, y: y + 3, 'text-anchor': 'middle', 'font-size': 8.5, 'font-weight': 700, fill: '#fff', 'font-family': Bc.fontStack(family) }, count));
      }
      g.appendChild(gm);
      if (C.display === 'callout') {
        var last = list[list.length - 1];
        var txt = ellipsize(last.text, C.maxWidth, C.size, 400, family);
        var lbl = boxLabel(txt, C.size, 400, family, 'rounded');
        lbl.bgFill = '#FFFFFF';
        lbl.bgStroke = color;
        lbl.fill = '#263244';
        lbl.prio = 1e18;
        var extra = 0;
        labels.forEach(function (l) { if (l.item === it && l.place === 'outsideEnd') extra = Math.max(extra, (vert ? l.h : l.w) + cfg.labels.offset); });
        placeOn(lbl, F, 'outsideEnd', 8 + extra);
        labels.push(lbl);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Hover highlight
  // ---------------------------------------------------------------------------
  function parseKey (k) {
    var o = {};
    String(k || '').split('|').forEach(function (part) {
      var i = part.indexOf(':');
      if (i > 0) o[part.slice(0, i)] = part.slice(i + 1);
    });
    return o;
  }

  /**
   * Every element that can fade on hover, with its parsed key and drawn item,
   * built once per paint so hovering doesn't query and parse the whole chart.
   */
  var hoverEls = [];
  function indexHover () {
    hoverEls = Array.prototype.map.call(el.plot.querySelectorAll('[data-k]'), function (e) {
      var it = e.hasAttribute('data-i') ? drawn[Number(e.getAttribute('data-i'))] : null;
      return { e: e, have: parseKey(e.getAttribute('data-k')), it: it || null, dim: false };
    });
    state.hoverKey = null;
    lastHover = null;
    // many marks: no fade transitions (they make every hover restyle hundreds of elements)
    el.plot.classList.toggle('many', drawn.length > 250);
  }

  function setHover (key) {
    if (state.hoverKey === key) return;
    state.hoverKey = key;
    var want = key ? (key.indexOf('d:') === 0 ? { d: key.slice(2) } : parseKey(key)) : null;
    if (want && (want.t != null || want.r != null)) want = null;
    var dk = want && want.d != null ? Number(want.d.slice(0, want.d.indexOf('|'))) : -1;
    var dv = want && want.d != null ? want.d.slice(want.d.indexOf('|') + 1) : null;
    for (var x = 0; x < hoverEls.length; x++) {
      var rec = hoverEls[x];
      var have = rec.have;
      var dim = false;
      if (!want) dim = false;
      else if (have.l != null) dim = want.l == null || want.l !== have.l;
      else if (want.l != null) dim = true;
      else if (dk >= 0) {
        var it = rec.it;
        var n = it && it.node;
        if (n) {
          var dp = n.dimPath || [];
          dim = isSeriesField(dk) ? !(it.b && it.b.s && it.b.s.parts && it.b.s.parts[raw.seriesIdx.indexOf(dk)] === dv)
            : dp[dk] != null ? dp[dk] !== dv : !n.items.some(function (q) { return q.b[dk] === dv; });
        }
      } else {
        dim = (want.c != null && want.c !== have.c) || (want.s != null && want.s !== have.s);
        if (!dim && want.o != null && rec.it && rec.it.node) dim = (want.o === 'oth') !== !!rec.it.node.isOthers;
      }
      if (dim !== rec.dim) { rec.dim = dim; rec.e.classList.toggle('is-dim', dim); }
    }
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------
  function itemFromEvent (e) {
    var g = e.target.closest ? e.target.closest('[data-i]') : null;
    if (!g) return null;
    return drawn[Number(g.getAttribute('data-i'))] || null;
  }

  // Mouse moves are handled once per frame; moving within the same bar only moves the tooltip,
  // and crossing the gap between two bars doesn't un-fade and re-fade the whole chart.
  var lastHover = null;
  var hoverClear = null;
  var hoverEvt = null;
  function onHoverEvent (e) {
    var first = !hoverEvt;
    hoverEvt = { target: e.target, clientX: e.clientX, clientY: e.clientY };
    if (first) requestAnimationFrame(function () { var ev = hoverEvt; hoverEvt = null; if (ev) onHover(ev); });
  }

  function clearHoverNow () {
    clearTimeout(hoverClear); hoverClear = null;
    hoverEvt = null;
    lastHover = null;
    if (!state.pinned) hideTooltip();
    setHover(null);
  }

  function onHover (e) {
    if (!cfg || el.menu.style.display === 'block' || state.pinned) return;
    var d = itemFromEvent(e);
    if (!d) {
      if (!hoverClear) hoverClear = setTimeout(function () { hoverClear = null; lastHover = null; hideTooltip(); setHover(null); }, 140);
      return;
    }
    clearTimeout(hoverClear); hoverClear = null;
    var seg = e.target.getAttribute && e.target.getAttribute('data-seg');
    if (lastHover && lastHover.d === d && lastHover.seg === seg) {
      if (cfg.tooltip.show) placeTooltip(e.clientX, e.clientY);
      return;
    }
    lastHover = { d: d, seg: seg };
    if (cfg.hover.dimOthers) {
      if (d.kind === 'line') setHover('l:' + d.line.key);
      else if (d.b) setHover('c:' + rootLabel(d.node) + (view.visSeries.length > 1 ? '|s:' + d.b.s.key : ''));
    }
    if (!cfg.tooltip.show) return;
    showTooltip(d, e.clientX, e.clientY, false, seg != null ? Number(seg) : null);
  }

  function showTooltip (d, x, y, pinned, segIdx) {
    var tt = el.tooltip;
    tt.innerHTML = tooltipHtml(d, pinned, segIdx);
    tt.style.fontFamily = Bc.fontStack(cfg.numbers.font);
    tt.classList.toggle('is-pinned', !!pinned);
    tt.style.display = 'block';
    if (pinned) wirePinned(d);
    ttSize = { w: tt.offsetWidth, h: tt.offsetHeight }; // measured once per content
    placeTooltip(x, y);
  }

  var ttSize = { w: 0, h: 0 };
  function placeTooltip (x, y) {
    var tt = el.tooltip;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = Math.min(Math.max(4, x + 12), vw - ttSize.w - 4);
    var top = y - ttSize.h - 12;
    if (top < 4) top = Math.min(y + 16, vh - ttSize.h - 4);
    tt.style.left = left + 'px';
    tt.style.top = Math.max(4, top) + 'px';
  }

  function fullOpts (fv, count) {
    return { full: cfg.tooltip.fullNumbers, fv: count === 1 ? fv : null };
  }

  /** Rows for the tooltip list: breakdown members, or every series of the category. */
  function tooltipRows (d) {
    var V = d.v || view; // the panel this bar is in (small multiples)
    var n = d.node;
    var TT = cfg.tooltip;
    if (TT.showBreakdown && raw.dims.length > n.depth && d.b) {
      var idx = [];
      for (var i = n.depth; i < raw.dims.length; i++) idx.push(i);
      var sums = {};
      var order = [];
      n.items.forEach(function (it) {
        if (it.s !== d.b.s.key) return;
        var name = idx.map(function (k) { return it.b[raw.dimPos[k]]; }).join(' · ');
        if (!(name in sums)) { sums[name] = 0; order.push(name); }
        sums[name] += it.v;
      });
      var spec = segSpec(n);
      var segs = spec ? segmentsOf(n, d.b.s.key, spec) : [];
      var colors = spec ? segColors(segs, d.b.color, spec) : {};
      var sh = Bc.shades(d.b.color, Math.max(1, order.length));
      var rows = order.map(function (k, j) { return { name: k, v: sums[k], color: colors[k] || sh[j] }; });
      if (rows.length > 1 || (rows.length === 1 && rows[0].name !== n.label)) {
        return { title: raw.dims.slice(n.depth).map(function (x) { return x.name; }).join(' · '), rows: rows, total: d.b.v };
      }
    }
    if (V.visSeries.length > 1 && TT.showSeries) {
      return { title: raw.seriesIdx.length ? raw.seriesFields.map(function (f) { return f.name; }).join(' · ') : 'Measure', rows: n.bars.map(function (b) { return { name: b.s.name, v: b.v, color: b.color, fv: b.fv, count: b.count, me: d.b && b.s.key === d.b.s.key }; }), total: n.bars.reduce(function (a, b) { return a + Math.abs(b.v); }, 0) };
    }
    return null;
  }

  function sortRows (rows, order) {
    var cmp = Bc.comparer(order === 'name' ? 'name' : order, function (r) { return r.v; }, function (r) { return r.name; });
    return Bc.sortBy(rows, cmp);
  }

  function tooltipHtml (d, pinned, segIdx) {
    var V = d.v || view;
    var n = d.node;
    var TT = cfg.tooltip;
    var f = tipFmt();
    var html = '';
    if (pinned) html += '<button class="tt-close" type="button" data-act="close" title="Close">×</button>';
    var path = n.parent ? n.pathLabel.slice(0, n.pathLabel.lastIndexOf(' › ')) : (n.outer && n.outer.length ? n.outer.join(' · ') : '');
    if (path) html += '<div class="tt-path">' + esc(path) + '</div>';
    html += '<div class="tt-name">' + esc(n.label) + '</div>';

    if (d.kind === 'line') {
      var lc = Bc.lineCfg(cfg, d.line.key);
      html += '<div class="tt-series"><span class="sw" style="display:inline-block;width:12px;height:3px;background:' + d.color + '"></span>' + esc(lineLabel(d.line)) + '</div>';
      html += '<div class="tt-value" style="color:' + d.color + '">' + esc(Bc.formatNumber(d.v, tipFmt(), { full: TT.fullNumbers })) + '</div>';
    } else if (d.b) {
      var b = d.b;
      if (V.series.length > 1 && TT.showSeries) {
        html += '<div class="tt-series"><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + b.color + '"></span>' + esc(b.s.name) + '</div>';
      } else if (raw.measures.length === 1 || V.axisType !== 'measureNames') {
        html += '<div class="tt-note">' + esc(b.s.name) + '</div>';
      }
      html += '<div class="tt-value" style="color:' + Bc.readable(b.color) + '">' + esc(Bc.formatNumber(b.v, f, fullOpts(b.fv, b.count))) + '</div>';
      if (TT.showPct) {
        var tot = V.totalsBySeries[b.s.key];
        var notes = [];
        if (tot && V.nodes.length > 1) notes.push(Bc.formatNumber(b.v / tot, pctFmt(f)) + ' of total');
        if (V.visSeries.length > 1) {
          var cs = n.bars.reduce(function (a, x) { return a + Math.abs(x.v); }, 0);
          if (cs) notes.push(Bc.formatNumber(b.v / cs, pctFmt(f)) + ' of ' + esc(n.label));
        }
        if (b.prev && b.prev.v) notes.push(Bc.formatNumber((b.v - b.prev.v) / Math.abs(b.prev.v), Bc.merge(pctFmt(f), { plusSign: true }), { signed: true }) + ' vs ' + esc(b.prev.node.label));
        if (notes.length) html += '<div class="tt-note">' + notes.join(' · ') + '</div>';
      }
      if (targetInfo() && !V.noTarget && isFinite(n.t) && cfg.target.inTooltip) {
        html += '<div class="tt-note">' + esc(fieldLabel(targetInfo())) + ': ' + esc(Bc.formatNumber(n.t, f, { full: TT.fullNumbers })) +
          (n.t ? ' (' + Bc.formatNumber(n.total / n.t, pctFmt(f)) + ' achieved)' : '') + '</div>';
      }
      if (n.isOthers && n.members) html += '<div class="tt-note">' + n.members.length + ' members: ' + esc(n.members.slice(0, 6).join(', ')) + (n.members.length > 6 ? '…' : '') + '</div>';

      var R = tooltipRows(d);
      if (R && R.rows.length) {
        var order = state.ttSort || TT.sort;
        var rows = sortRows(R.rows, order);
        var max = pinned ? rows.length : Math.max(1, TT.maxRows);
        html += '<div class="tt-rows">';
        if (pinned) {
          var btn = function (key, label) {
            var on = order === key || (key === 'val' && (order === 'valDesc' || order === 'valAsc')) || (key === 'name' && (order === 'name' || order === 'nameDesc'));
            var arrow = on ? (order === 'valAsc' || order === 'name' ? ' ▲' : ' ▼') : '';
            return '<button type="button" data-sort="' + key + '" class="' + (on ? 'is-on' : '') + '">' + label + arrow + '</button>';
          };
          html += '<div class="tt-head"><span class="nm">' + btn('name', esc(R.title || 'Name')) + '</span>' + btn('val', 'Value') + (TT.showPct ? '<span class="pc">%</span>' : '') + '</div>';
        } else if (R.title) {
          html += '<div class="tt-head"><span class="nm">' + esc(R.title) + '</span></div>';
        }
        var segName = segIdx != null && d.segs && d.segs[segIdx] ? d.segs[segIdx].seg.member : null;
        if (segIdx != null && d.item && d.item.segs) segName = d.item.segs[segIdx] && d.item.segs[segIdx].seg.member;
        rows.slice(0, max).forEach(function (r) {
          var me = r.me || (segName != null && r.name === segName);
          html += '<div class="tt-row"' + (me ? ' style="font-weight:700"' : '') + '><span class="sw" style="background:' + r.color + '"></span><span class="nm">' + esc(r.name) +
            '</span><span class="vl">' + esc(Bc.formatNumber(r.v, f, fullOpts(r.fv, r.count))) + '</span>' +
            (TT.showPct ? '<span class="pc">' + (R.total ? esc(Bc.formatNumber(r.v / R.total, pctFmt(f))) : '') + '</span>' : '') + '</div>';
        });
        if (rows.length > max) html += '<div class="tt-more">+ ' + (rows.length - max) + ' more — click the bar to see all</div>';
        html += '</div>';
      }
    }

    if (TT.showLines && d.kind !== 'line' && raw.lines.length) {
      var lr = raw.lines.filter(function (l) { return isFinite(n.l[l.key]); });
      if (lr.length) {
        html += '<div class="tt-rows">' + lr.map(function (l) {
          var lc2 = Bc.lineCfg(cfg, l.key);
          return '<div class="tt-row"><span class="sw" style="height:3px;background:' + lineColor(l.key, raw.lines.indexOf(l)) + '"></span><span class="nm">' + esc(lineLabel(l)) +
            '</span><span class="vl">' + esc(Bc.formatNumber(n.l[l.key], tipFmt(), { full: TT.fullNumbers })) + '</span></div>';
        }).join('') + '</div>';
      }
    }
    if (TT.showExtra && raw.extras.length) {
      var tgi = targetInfo();
      // every Tooltip-tile field as "name: value", in tile order
      var xr = raw.extras.filter(function (x) {
        return isFinite(n.x[x.key]) || (n.xt && n.xt[x.key] && n.xt[x.key].length);
      });
      if (xr.length) {
        html += '<div class="tt-rows tt-kv">' + xr.map(function (x) {
          var val;
          if (!isFinite(n.x[x.key])) {
            var a = n.xt[x.key];
            val = a.length <= 3 ? a.join(', ') : a.slice(0, 3).join(', ') + ' +' + (a.length - 3) + ' more';
          } else val = n.xf && n.xf[x.key] && !n.isOthers ? n.xf[x.key] : Bc.formatNumber(n.x[x.key], f, { full: TT.fullNumbers });
          return '<div class="tt-row"><span class="nm">' + esc(fieldLabel(x)) + ':</span><span class="vl">' + esc(val) + '</span></div>';
        }).join('') + '</div>';
      }
    }
    var notes2 = commentsOf(n);
    if (notes2.length && cfg.comments.show) {
      notes2.forEach(function (c) {
        html += '<div class="tt-comment" style="border-left-color:' + (c.color || cfg.comments.color) + '">' + esc(c.text) +
          (c.author || c.date ? '<div class="by">' + esc([c.author, c.date].filter(Boolean).join(' · ')) + '</div>' : '') + '</div>';
      });
    }
    if (!pinned) {
      var hints = [];
      if (TT.pinOnClick) hints.push('Click to pin');
      if (canDrill(n) && cfg.interaction.dblclick === 'drill') hints.push('double-click to drill down');
      if (hints.length) html += '<div class="tt-hint">' + hints.join(' · ') + '</div>';
    }
    return html;
  }

  function wirePinned (d) {
    var tt = el.tooltip;
    Array.prototype.forEach.call(tt.querySelectorAll('[data-sort]'), function (b) {
      b.addEventListener('click', function () {
        var cur = state.ttSort || cfg.tooltip.sort;
        var k = b.getAttribute('data-sort');
        if (k === 'val') state.ttSort = cur === 'valDesc' ? 'valAsc' : 'valDesc';
        else state.ttSort = cur === 'name' ? 'nameDesc' : 'name';
        var r = tt.getBoundingClientRect();
        tt.innerHTML = tooltipHtml(d, true);
        wirePinned(d);
        tt.style.left = r.left + 'px';
        tt.style.top = r.top + 'px';
      });
    });
    var close = tt.querySelector('[data-act="close"]');
    if (close) close.addEventListener('click', unpin);
  }

  function unpin () {
    if (!state.pinned) return;
    state.pinned = null;
    state.ttSort = null;
    hideTooltip();
  }

  function hideTooltip () {
    if (el.tooltip) { el.tooltip.style.display = 'none'; el.tooltip.classList.remove('is-pinned'); }
  }

  function hideTooltipIfStale () {
    if (state.pinned) { state.pinned = null; state.ttSort = null; }
    hideTooltip();
  }

  // ---------------------------------------------------------------------------
  // Click, double-click, drill
  // ---------------------------------------------------------------------------
  /** The bar (or line point), its value label, or its name on the axis under the pointer. */
  function hitFromEvent (e) {
    var d = itemFromEvent(e);
    if (d) return { d: d, n: d.node };
    var c = e.target.closest ? e.target.closest('[data-cat]') : null;
    var n = c ? catRefs[Number(c.getAttribute('data-cat'))] : null;
    return n ? { d: null, n: n } : null;
  }

  var clickTimer = null;
  function onClick (e) {
    if (!cfg) return;
    if (e.detail > 1) return; // second click of a double-click
    var hit = hitFromEvent(e);
    if (hit && hit.d && hit.d.kind === 'comment') { openNote(hit.d.node, e.clientX, e.clientY); return; }
    var x = e.clientX; var y = e.clientY;
    var run = function () { clickTimer = null; doClick(hit, x, y); };
    // wait a moment when a double-click does something, so a double-click doesn't select first
    clearTimeout(clickTimer);
    if (hit && cfg.interaction.dblclick && cfg.interaction.dblclick !== 'none') clickTimer = setTimeout(run, 240);
    else run();
  }

  function doClick (hit, x, y) {
    if (!hit) {
      unpin();
      if (state.sel) clearSelection();
      return;
    }
    var same = state.sel === selKey(hit.n);
    if (hit.d && cfg.tooltip.show && cfg.tooltip.pinOnClick) {
      if (same && state.pinned) unpin();
      else { state.pinned = hit.d; state.ttSort = null; showTooltip(hit.d, x, y, true); }
    }
    if (cfg.interaction.selectInTableau) {
      // click the selected category again → undo; another one → select that instead
      if (same) clearSelection();
      else { state.sel = selKey(hit.n); selectInTableau(hit.n); markSelection(); }
    }
  }

  /** A bar's identity for click-selection: its category, and its panel with small multiples. */
  function selKey (n) { return n.key + '\u0004' + (n.panel || ''); }

  function clearSelection () {
    state.sel = null;
    clearTableauSelection();
    markSelection();
  }

  /** Fades everything but the selected category (bars, value labels, names, icons). */
  function markSelection () {
    if (!el.plot || !view) return;
    var sel = state.sel;
    if (sel && !catRefs.some(function (n) { return selKey(n) === sel; }) && !drawn.some(function (it) { return it.node && selKey(it.node) === sel; })) { state.sel = sel = null; }
    Array.prototype.forEach.call(el.plot.querySelectorAll('[data-i],[data-cat]'), function (e) {
      var n = null;
      if (e.hasAttribute('data-i')) { var it = drawn[Number(e.getAttribute('data-i'))]; n = it && it.node; }
      else n = catRefs[Number(e.getAttribute('data-cat'))];
      e.classList.toggle('is-unsel', !!(sel && n && selKey(n) !== sel));
    });
    el.plot.classList.toggle('has-sel', !!sel);
  }

  function onDblClick (e) {
    clearTimeout(clickTimer); clickTimer = null;
    var hit = hitFromEvent(e);
    var d = hit && (hit.d || (hit.n.bars && hit.n.bars[0] ? drawn.find(function (x) { return x.node === hit.n && x.kind === 'bar'; }) : null));
    if (!d || !cfg) return;
    unpin();
    var act = cfg.interaction.dblclick;
    if (act === 'drill' && canDrill(d.node)) drillDown(d.node);
    else if (act === 'drill' && d.node.parent && cfg.drill.mode === 'expandOne') collapse(d.node.parent);
    else if (act === 'format' || act === 'drill') openDialog({ tab: 'bars', item: d.b ? d.b.s.key : null, member: d.node.label });
  }

  function canDrill (n) {
    return !!(cfg.drill.enabled && raw && raw.dims.length > n.depth);
  }

  var expOrder = [];
  function drillDown (n) {
    var D = cfg.drill;
    if (D.mode === 'focus') state.focus.push(n.key);
    else if (D.mode === 'expandAll') state.level = Math.min(raw.dims.length, n.depth + 1);
    else { state.expanded[n.key] = true; expOrder.push(n.key); }
    state.animate = true;
    paint();
  }

  function collapse (n) {
    Object.keys(state.expanded).forEach(function (k) { if (k === n.key || k.indexOf(n.key + CS) === 0) delete state.expanded[k]; });
    expOrder = expOrder.filter(function (k) { return state.expanded[k]; });
    state.animate = true;
    paint();
  }

  function drillUp () {
    var D = cfg.drill;
    if (D.mode === 'focus') state.focus.pop();
    else if (D.mode === 'expandAll') state.level = Math.max(0, state.level - 1);
    else {
      var k = expOrder.pop();
      while (k && !state.expanded[k]) k = expOrder.pop();
      if (k) delete state.expanded[k];
      else state.expanded = {};
    }
    state.animate = true;
    paint();
  }

  function resetDrill () {
    state.expanded = {}; expOrder = []; state.focus = []; state.level = 0;
    state.animate = true;
    paint();
  }

  /** Selects the bar's members in Tableau (for dashboard actions). Silently skipped if not supported. */
  function selectInTableau (n) {
    try {
      if (!worksheet || !worksheet.selectMarksByValueAsync) return;
      var sel = [];
      var root = n; var chain = [];
      while (root) { chain.unshift(root); root = root.parent; }
      var top = chain[0];
      if (view.axisType !== 'measureNames') {
        raw.catFields.forEach(function (f, i) { if (top.path[i] != null) sel.push({ fieldName: f.name, value: [top.path[i]] }); });
      }
      chain.slice(1).forEach(function (c, i) { if (raw.dims[i]) sel.push({ fieldName: raw.dims[i].name, value: [c.label] }); });
      (n.panelVals || []).forEach(function (pv) { sel.push({ fieldName: pv.field.name, value: [pv.value] }); }); // small multiples: that panel only
      if (!sel.length) return;
      var type = tableau.SelectionUpdateType ? tableau.SelectionUpdateType.Replace : 'select-replace';
      worksheet.selectMarksByValueAsync(sel, type).catch(function (err) { console.info('Bar Chart: selection not applied', err && err.message); });
    } catch (e) { /* not supported */ }
  }

  function clearTableauSelection () {
    try { if (worksheet && worksheet.clearSelectedMarksAsync) worksheet.clearSelectedMarksAsync().catch(function () {}); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Right-click menu
  // ---------------------------------------------------------------------------
  function onContextMenu (e) {
    if (!cfg || !cfg.interaction.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    state.pinned = null;
    var d = itemFromEvent(e);
    var items = [];
    var n = d && d.node;
    if (n) {
      items.push({ head: n.pathLabel + (d.b && view.visSeries.length > 1 ? ' · ' + d.b.s.name : '') });
      items.push(['Format “' + (d.b && view.cmode === 'measures' ? d.b.s.name : n.label) + '” colour…', function () { openDialog({ tab: 'bars', item: d.b ? d.b.s.key : null, member: n.label }); }]);
      var nc = commentsOf(n).length;
      items.push([nc ? 'Comments (' + nc + ')…' : 'Add comment…', function () { openNote(n, e.clientX, e.clientY); }]);
      if (canDrill(n)) items.push(['Drill down to ' + raw.dims[n.depth].name, function () { drillDown(n); }]);
      if (n.parent && cfg.drill.mode === 'expandOne') items.push(['Collapse “' + n.parent.label + '”', function () { collapse(n.parent); }]);
      items.push(null);
      items.push(['Keep only “' + rootLabel(n) + '”', function () { keepOnly(n); }]);
      items.push(['Hide “' + rootLabel(n) + '”', function () { hideMember(rootLabel(n)); }]);
      var hl = (cfg.colors.highlight || []).indexOf(n.label) >= 0;
      items.push([hl ? 'Remove highlight' : 'Highlight “' + n.label + '”', function () { toggleHighlight(n.label); }]);
    }
    if (isDrilled()) {
      items.push(null);
      items.push(['Drill up', drillUp], ['Reset drill-down', resetDrill]);
    }
    var hidden = (cfg.interaction.hidden || []).length;
    if (hidden) items.push(['Show hidden bars (' + hidden + ')', function () { setSaved(function (c) { c.interaction.hidden = []; }); }]);
    items.push(null);
    items.push(['Chart type…', function () { openDialog({ tab: 'type' }); }],
      ['Bars…', function () { openDialog({ tab: 'bars' }); }],
      ['Value text…', function () { openDialog({ tab: 'labels' }); }],
      ['Dimension axis…', function () { openDialog({ tab: 'dimaxis' }); }],
      ['Measure axis…', function () { openDialog({ tab: 'measaxis' }); }],
      ['Legend…', function () { openDialog({ tab: 'legend' }); }],
      null,
      ['Format extension…', function () { openDialog(null); }]);

    var m = el.menu;
    m.innerHTML = '';
    var prevSep = true;
    items.forEach(function (it) {
      if (!it) { if (!prevSep) m.appendChild(document.createElement('hr')); prevSep = true; return; }
      prevSep = false;
      if (it.head) { var h = document.createElement('div'); h.className = 'menu-head'; h.textContent = it.head; m.appendChild(h); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it[0];
      btn.addEventListener('click', function () { hideMenu(); it[1](); });
      m.appendChild(btn);
    });
    m.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    m.style.left = Math.max(2, Math.min(e.clientX, vw - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(2, Math.min(e.clientY, vh - m.offsetHeight - 4)) + 'px';
  }

  function hideMenu () {
    if (el.menu) el.menu.style.display = 'none';
  }

  /** Changes a saved setting from the chart (works while authoring; viewers keep it for the session). */
  function setSaved (fn) {
    var c = Bc.read();
    fn(c);
    fn(cfg);
    state.animate = true;
    paint();
    try {
      Bc.write(c).catch(function (err) { console.info('Bar Chart: setting kept for this session only', err && err.message); });
    } catch (e) { /* read-only */ }
  }

  function hideMember (label) {
    setSaved(function (c) { if (c.interaction.hidden.indexOf(label) < 0) c.interaction.hidden.push(label); });
  }

  function keepOnly (n) {
    var keep = rootLabel(n);
    var others = view.allNodes.map(function (x) { return x.label; }).filter(function (l) { return l !== keep; });
    setSaved(function (c) { c.interaction.hidden = others.slice(); });
  }

  function toggleHighlight (label) {
    setSaved(function (c) {
      var i = c.colors.highlight.indexOf(label);
      if (i >= 0) c.colors.highlight.splice(i, 1); else c.colors.highlight.push(label);
      c.colors.mode = 'highlight';
      c.colors.highlightBy = 'auto';
    });
  }

  // ---------------------------------------------------------------------------
  // Comment editor
  // ---------------------------------------------------------------------------
  function openNote (n, x, y) {
    hideMenu();
    unpin();
    var box = el.note;
    var list = commentsOf(n);
    box.innerHTML = '';
    var title = document.createElement('div');
    title.className = 'ne-title';
    title.textContent = 'Comments — ' + n.pathLabel;
    box.appendChild(title);
    if (list.length) {
      var ul = document.createElement('div');
      ul.className = 'ne-list';
      list.forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'ne-item';
        var t = document.createElement('span');
        t.textContent = c.text + (c.author || c.date ? '  — ' + [c.author, c.date].filter(Boolean).join(', ') : '');
        var del = document.createElement('button');
        del.type = 'button';
        del.textContent = 'Delete';
        del.addEventListener('click', function () { saveNotes(n, list.filter(function (x) { return x.id !== c.id; }), msg); closeNote(); });
        row.append(t, del);
        ul.appendChild(row);
      });
      box.appendChild(ul);
    }
    var ta = document.createElement('textarea');
    ta.placeholder = 'Write a comment for this bar…';
    box.appendChild(ta);
    var rowB = document.createElement('div');
    rowB.className = 'ne-row';
    var msg = document.createElement('span');
    msg.className = 'msg';
    var cancel = button('Close', closeNote);
    var save = button('Add', function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      var d = new Date();
      var entry = { id: 'n' + Date.now().toString(36), text: text, author: cfg.comments.author || '', date: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2), color: '' };
      saveNotes(n, list.concat([entry]), msg).then(function (ok) { if (ok) closeNote(); });
    });
    save.className = 'primary';
    rowB.append(msg, cancel, save);
    box.appendChild(rowB);
    box.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    box.style.left = Math.max(4, Math.min(x, vw - box.offsetWidth - 4)) + 'px';
    box.style.top = Math.max(4, Math.min(y, vh - box.offsetHeight - 4)) + 'px';
    setTimeout(function () { ta.focus(); }, 0);
  }

  function saveNotes (n, list, msg) {
    var c = Bc.read();
    if (list.length) c.comments.items[n.key] = list; else delete c.comments.items[n.key];
    cfg.comments.items = Bc.clone(c.comments.items);
    paint();
    try {
      return Bc.write(c).then(function () { return true; }).catch(function () {
        if (msg) msg.textContent = 'Saved for this session only: comments are stored in the workbook while you edit it.';
        return false;
      });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function closeNote () { if (el.note) el.note.style.display = 'none'; }

  // ---------------------------------------------------------------------------
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    el.hint.innerHTML = html;
  }

  window.BarChart = { init: init, _state: state, _view: function () { return view; } };
})();
