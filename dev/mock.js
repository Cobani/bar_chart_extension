'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the chart and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - Sample data: ?data=sales | monthly | compare | grouped | stacked |
 *   progress | negative | nested | raw | measures | top | ages
 * - ?rename: the first Axis pill is "renamed" (//New name), so the Marks card
 *   reports a different name than the data column, as Tableau does.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var DS_KEY = 'bcMockData';
  var SET_KEY = 'bcMockSettings';
  var PAYLOAD_KEY = 'bcMockPayload';

  // deterministic pseudo-random numbers
  var seed = 7;
  function rnd () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  var SUBCATS = ['Phones', 'Chairs', 'Storage', 'Tables', 'Binders', 'Machines', 'Accessories', 'Copiers', 'Bookcases', 'Appliances', 'Furnishings', 'Paper'];
  var REGIONS = ['Central', 'East', 'South', 'West'];
  var SEGMENTS = ['Consumer', 'Corporate', 'Home Office'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function cross (a, b) { var o = []; a.forEach(function (x) { b.forEach(function (y) { o.push([x, y]); }); }); return o; }

  // Parameters (for <Parameter> in titles and measure names). window.mockSetParam('Selected Measure', 'Revenue') changes one.
  var MOCK_PARAMS = [['Selected Measure', 'Revenue'], ['Region Param', 'West'], ['Report Month', 'October 2026']].map(function (p) {
    var o = { name: p[0], id: p[0], currentValue: { value: p[1], formattedValue: p[1] }, _h: [] };
    o.addEventListener = function (t, h) { o._h.push(h); };
    return o;
  });
  window.mockSetParam = function (name, value) {
    MOCK_PARAMS.forEach(function (p) { if (p.name === name) { p.currentValue = { value: value, formattedValue: value }; p._h.forEach(function (h) { h({}); }); } });
  };

  var DATASETS = {
    // Sales by Sub-Category, Breakdown Region > Segment, Line, Target, Tooltip
    sales: function () {
      var rows = [];
      SUBCATS.forEach(function (sc, i) {
        var base = 330000 - i * 21000 + rnd() * 30000;
        cross(REGIONS, SEGMENTS).forEach(function (rs) {
          var w = (0.6 + rnd()) / 12;
          rows.push({ 'Region Manager': { Central: 'Kelly Williams', East: 'Chuck Magee', South: 'Cassandra Brandow', West: 'Anna Andreadi' }[rs[0]], 'ATTR(Ship Mode)': i % 3 ? 'Standard Class' : 'First Class', 'Sub-Category': sc, Region: rs[0], Segment: rs[1], 'SUM(Sales)': base * w, 'SUM(Profit)': base * w * (0.05 + rnd() * 0.22), 'SUM(Target)': base * w * (0.9 + rnd() * 0.25), 'SUM(Quantity)': Math.round(base * w / 90) });
        });
      });
      return { tiles: { category: ['Sub-Category', 'Region', 'Segment'], values: ['SUM(Sales)'], line: ['SUM(Profit)'], target: ['SUM(Target)'], tooltip: ['Region Manager', 'SUM(Quantity)', 'ATTR(Ship Mode)'] }, rows: rows };
    },
    monthly: function () {
      var vals = [42.8, 45.0, 41.9, 38.8, 37.6, 46.5, 46.0, 41.4, 35.2, 31.4, 37.7, 49.5];
      return { tiles: { category: ['MONTH(Flight Date)'], values: ['AVG(Arrival Delay)'], line: ['AVG(Departure Delay)'] },
        rows: MONTHS.map(function (m, i) { return { 'MONTH(Flight Date)': m, 'AVG(Arrival Delay)': vals[i], 'AVG(Departure Delay)': vals[i] * (0.7 + rnd() * 0.3) }; }) };
    },
    compare: function () {
      var prods = ['Nail polish', 'Eyebrow pencil', 'Rouge', 'Lipstick', 'Eyeshadows', 'Eyeliner', 'Foundation', 'Lip gloss', 'Mascara', 'Shampoo', 'Hair conditioner', 'Body lotion', 'Shower gel', 'Soap', 'Deodorant', 'Hand cream'];
      return { tiles: { category: ['Product'], values: ['SUM(Males)', 'SUM(Females)'] },
        rows: prods.map(function (p) { return { Product: p, 'SUM(Males)': Math.round(rnd() * rnd() * 14000), 'SUM(Females)': Math.round(4000 + rnd() * 9000) }; }) };
    },
    grouped: function () {
      var rows = ['2020', '2021', '2022', '2023', '2024'].map(function (y) {
        return { 'YEAR(Date)': y, 'SUM(Data 1)': Math.round(40 + rnd() * 50), 'SUM(Data 2)': Math.round(43 + rnd() * 50), 'SUM(Data 3)': Math.round(46 + rnd() * 50) };
      });
      return { tiles: { category: ['YEAR(Date)'], values: ['SUM(Data 1)', 'SUM(Data 2)', 'SUM(Data 3)'] }, rows: rows };
    },
    stacked: function () {
      var mix = { Ferry: [80, 9, 11], Bus: [75, 12, 13], Car: [50, 35, 15], Train: [40, 50, 10], Carpool: [28, 66, 6], Bike: [20, 60, 20], Motorcycle: [13, 73, 14], Taxi: [10, 25, 65] };
      var rows = Object.keys(mix).map(function (k) {
        return { Transport: k, 'SUM(Customers)': mix[k][0], 'SUM(Employees)': mix[k][1], 'SUM(Tourists)': mix[k][2] };
      });
      return { tiles: { category: ['Transport'], values: ['SUM(Customers)', 'SUM(Employees)', 'SUM(Tourists)'] }, rows: rows };
    },
    progress: function () {
      var v = [0.8, 0.7, 0.6, 0.5, 0.4];
      return { tiles: { category: ['Title'], values: ['AVG(Completion)'], target: ['AVG(Goal)'] },
        rows: v.map(function (x, i) { return { Title: 'Title 0' + (i + 1), 'AVG(Completion)': x, 'AVG(Goal)': Math.min(1, x + 0.1) }; }) };
    },
    negative: function () {
      return { tiles: { category: ['Sub-Category'], values: ['SUM(Profit)'] },
        rows: SUBCATS.map(function (s, i) { return { 'Sub-Category': s, 'SUM(Profit)': Math.round((rnd() - 0.32) * 60000 - i * 900) }; }) };
    },
    // One measure; Dimension tile: Age group › Gender (two values, for left-right)
    ages: function () {
      var rows = [];
      ['0-9', '10-19', '20-29', '30-39', '40-49', '50-59', '60-69', '70+'].forEach(function (g, i) {
        var base = 5200 - Math.abs(i - 3) * 900;
        rows.push({ 'Age group': g, Gender: 'Male', 'SUM(Population)': base * (0.9 + rnd() * 0.2) });
        rows.push({ 'Age group': g, Gender: 'Female', 'SUM(Population)': base * (0.92 + rnd() * 0.2) });
      });
      return { tiles: { category: ['Age group', 'Gender'], values: ['SUM(Population)'] }, rows: rows };
    },
    nested: function () {
      var rows = [];
      [['Furniture', ['Bookcases', 'Chairs', 'Furnishings', 'Tables']], ['Office Supplies', ['Appliances', 'Binders', 'Paper', 'Storage']], ['Technology', ['Accessories', 'Copiers', 'Machines', 'Phones']]].forEach(function (g) {
        g[1].forEach(function (s) {
          var sales = Math.round(60000 + rnd() * 190000);
          rows.push({ Category: g[0], 'Sub-Category': s, 'SUM(Sales)': sales, 'SUM(Profit)': Math.round(sales * (0.04 + rnd() * 0.25)) });
        });
      });
      return { tiles: { category: ['Category', 'Sub-Category'], values: ['SUM(Sales)', 'SUM(Profit)'] }, rows: rows };
    },
    raw: function () {
      var names = ['Paseo', 'VTT', 'Amarilla', 'Velo', 'Montana', 'Carretera'];
      var vals = [4.8e6, 3.0e6, 2.8e6, 2.3e6, 2.1e6, 1.8e6];
      return { tiles: { category: ['Product'], values: ['SUM(Gross Sales)'] }, rows: names.map(function (n, i) { return { Product: n, 'SUM(Gross Sales)': vals[i] + rnd() * 1e5 }; }) };
    },
    measures: function () {
      return { tiles: { values: ['SUM(Bank In)', 'SUM(Wallet In)', 'SUM(Top-up)', 'SUM(Card Txns)', 'SUM(SADAD)'] },
        rows: [{ 'SUM(Bank In)': 262.1e6, 'SUM(Wallet In)': 36.3e6, 'SUM(Top-up)': 74.3e6, 'SUM(Card Txns)': 72.9e6, 'SUM(SADAD)': 31.2e6 }] };
    },
    top: function () {
      var c = ['Hong Kong', 'Luxembourg', 'Singapore', 'San Marino', 'Djibouti', 'Malta', 'Ireland', 'Vietnam', 'Slovakia', 'Seychelles', 'Belgium', 'Hungary', 'Slovenia', 'UA Emirates', 'Netherlands', 'Maldives', 'Bahrain', 'Cyprus', 'Lithuania', 'Aruba', 'Czechia', 'Estonia', 'Lesotho', 'Belarus', 'Barbados'];
      return { tiles: { category: ['Country'], values: ['AVG(Trade % of GDP)'] }, rows: c.map(function (x, i) { return { Country: x, 'AVG(Trade % of GDP)': 376.3 - i * 9 - rnd() * 8 }; }) };
    }
  };

  var dsName = params.get('data') || localStorage.getItem(DS_KEY) || 'sales';
  var DS = (DATASETS[dsName] || DATASETS.sales)();
  var RENAME = /[?&]rename\b/.test(location.search);

  function cell (v) {
    return { value: v, nativeValue: v, formattedValue: typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v) };
  }

  var ORDER = ['category', 'values', 'line', 'target', 'tooltip'];
  var DIMS = { category: 1 };
  // Tooltip tile: plain names are dimensions, AGG(name) measures
  function isDim (f) { return DIMS[f.tile] || (f.tile === 'tooltip' && !/^[A-Z]+\(/.test(f.name)); }

  function allFields () {
    var out = [];
    ORDER.forEach(function (t) { (DS.tiles[t] || []).forEach(function (n) { out.push({ tile: t, name: n }); }); });
    return out;
  }

  function buildTable () {
    var cols = allFields().map(function (f, i) {
      var name = RENAME && f.tile === 'category' && i === 0 ? 'Calculation_8812' : f.name;
      return { fieldName: name, fieldId: '[' + name + ']', dataType: isDim(f) || /^ATTR\(/.test(f.name) ? 'string' : 'float', index: i, src: f.name };
    });
    var data = DS.rows.map(function (r) { return cols.map(function (c) { return cell(r[c.src]); }); });
    return { columns: cols.map(function (c) { return { fieldName: c.fieldName, fieldId: c.fieldId, dataType: c.dataType, index: c.index }; }), data: data };
  }

  // Tooltip measures sit on Tableau's own Tooltip tile, which comes with a type.
  function encodings () {
    return allFields().map(function (f, i) {
      var name = RENAME && f.tile === 'category' && i === 0 ? 'Product line (renamed)' : f.name;
      var builtIn = f.tile === 'tooltip' ? 'tooltip' : null;
      return { id: builtIn || f.tile, type: builtIn || 'custom', field: { name: name, id: '[' + name + ']', role: isDim(f) ? 'dimension' : 'measure' } };
    });
  }

  // ---- settings ----------------------------------------------------------
  function loadSettings () {
    try { return JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { return {}; }
  }
  var pending = loadSettings();
  var settingsHandlers = [];
  window.addEventListener('storage', function (e) {
    if (e.key === SET_KEY) {
      pending = loadSettings();
      settingsHandlers.forEach(function (h) { h({}); });
    }
  });

  var configureFn = null;
  var dialogResolve = null;
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'bc-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'bc-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed', ParameterChanged: 'parameter-changed' },
    DialogStyle: { Modeless: 'modeless' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    SelectionUpdateType: { Replace: 'select-replace' },
    extensions: {
      initializeAsync: function (opts) {
        configureFn = opts && opts.configure;
        return Promise.resolve();
      },
      initializeDialogAsync: function () {
        return Promise.resolve(localStorage.getItem(PAYLOAD_KEY) || '');
      },
      settings: {
        get: function (k) { return pending[k]; },
        set: function (k, v) { pending[k] = v; },
        getAll: function () { return pending; },
        saveAsync: function () {
          localStorage.setItem(SET_KEY, JSON.stringify(pending));
          settingsHandlers.forEach(function (h) { h({}); });
          return Promise.resolve();
        },
        addEventListener: function (type, h) { settingsHandlers.push(h); }
      },
      worksheetContent: {
        worksheet: {
          name: 'Mock sheet',
          addEventListener: function () {},
          getVisualSpecificationAsync: function () {
            return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: encodings() }] });
          },
          getSummaryDataReaderAsync: function () {
            var t = buildTable();
            return Promise.resolve({
              getAllPagesAsync: function () { return Promise.resolve(t); },
              releaseAsync: function () { return Promise.resolve(); }
            });
          },
          selectMarksByValueAsync: function (sel) { console.log('mock selectMarksByValueAsync', JSON.stringify(sel)); return Promise.resolve(); },
          clearSelectedMarksAsync: function () { console.log('mock clearSelectedMarksAsync'); return Promise.resolve(); },
          getParametersAsync: function () { return Promise.resolve(MOCK_PARAMS); }
        }
      },
      ui: {
        displayDialogAsync: function (url, payload) {
          localStorage.setItem(PAYLOAD_KEY, payload || '');
          var target = window.parent !== window ? window.parent : null;
          if (target) target.postMessage({ type: 'bc-open-dialog', url: url }, '*');
          else window.open(url, 'bc-dialog', 'width=620,height=780');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'bc-close-dialog' }, '*');
          else window.close();
        }
      }
    }
  };
})();
