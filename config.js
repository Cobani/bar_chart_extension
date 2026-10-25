'use strict';

/**
 * Bar Chart — shared configuration.
 *
 * Loaded by both the chart (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, number formatting,
 * colour palettes and the built-in icon set (the same set as KPI Card 3 and
 * Waterfall).
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  var STORAGE_KEY = 'barChart1';

  var FONT_STACK_FALLBACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  /** Font families offered in the dialog. "Lato" ships with the extension. */
  var FONTS = [
    'Lato',
    'IBM Plex Sans',
    'Tableau Book',
    'Tableau Medium',
    'Tableau Semibold',
    'Tableau Bold',
    'Benton Sans',
    'Arial',
    'Helvetica Neue',
    'Segoe UI',
    'Roboto',
    'Open Sans',
    'Georgia',
    'Times New Roman',
    'Courier New'
  ];

  /**
   * Number format: KPI Card's "Big number" options plus Waterfall's signs.
   * Used globally (Numbers tab) and, when the scope is "each", by every part
   * of the chart that writes numbers.
   */
  var FORMAT = {
    scale: 'dynamic', // none | K | M | B | dynamic | workbook | percent | percentDynamic
    decimals: 1,
    pctFromRatio: true, // percent formats: value is a 0–1 ratio (0.4523 → 45.23%)
    thousands: true, // 1,284,500 vs 1284500
    unit: '',
    unitPosition: 'suffix', // suffix | prefix
    unitSpace: true, // "12.5 M SAR" vs "12.5MSAR"
    plusSign: false, // "+262.1" on positive values
    negStyle: 'minus' // minus (−201.4) | hyphen (-201.4) | paren ((201.4))
  };

  function fmtCopy (over) {
    var f = JSON.parse(JSON.stringify(FORMAT));
    Object.keys(over || {}).forEach(function (k) { f[k] = over[k]; });
    return f;
  }

  /** Colour palettes (first colour = first series / category). */
  var PALETTES = {
    house: { label: 'House', colors: ['#2F4B7C', '#EB644C', '#0E7C66', '#6B4FB0', '#F2A93B', '#3BA7C4', '#C4566F', '#8A9A5B', '#B4431E', '#68707D'] },
    tableau10: { label: 'Tableau 10', colors: ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC'] },
    tableau20: { label: 'Tableau 20', colors: ['#4E79A7', '#A0CBE8', '#F28E2B', '#FFBE7D', '#59A14F', '#8CD17D', '#B6992D', '#F1CE63', '#499894', '#86BCB6', '#E15759', '#FF9D9A', '#79706E', '#BAB0AC', '#D37295', '#FABFD2', '#B07AA1', '#D4A6C8', '#9D7660', '#D7B5A6'] },
    colorBlind: { label: 'Color blind', colors: ['#1170AA', '#FC7D0B', '#A3ACB9', '#57606C', '#5FA2CE', '#C85200', '#7B848F', '#A3CCE9', '#FFBC79', '#C8D0D9'] },
    vivid: { label: 'Infographic vivid', colors: ['#F45B69', '#F7A541', '#6A5ACD', '#3BB2B8', '#9B59B6', '#2ECC71', '#E67E22', '#1ABC9C', '#E84393', '#0984E3'] },
    cool: { label: 'Cool gradient', colors: ['#8B5CF6', '#6E8BFF', '#4FB0FF', '#3EE6F5', '#3DF0C8', '#34D399', '#22C55E', '#84CC16'] },
    warm: { label: 'Warm', colors: ['#B4431E', '#E4572E', '#F28E2B', '#F2A93B', '#EDC948', '#C4566F', '#9C755F', '#E15759'] },
    pastel: { label: 'Pastel', colors: ['#A0CBE8', '#FFBE7D', '#8CD17D', '#F1CE63', '#86BCB6', '#FF9D9A', '#D4A6C8', '#D7B5A6', '#BAB0AC', '#FABFD2'] },
    blues: { label: 'Blues', colors: ['#08306B', '#08519C', '#2171B5', '#4292C6', '#6BAED6', '#9ECAE1', '#C6DBEF'] },
    office: { label: 'Office', colors: ['#7CC4FA', '#3A8DDE', '#F0812F', '#FFD966', '#8BC34A', '#B39DDB', '#4DB6AC', '#E57373'] },
    duo: { label: 'Blue / pink', colors: ['#3A7FD5', '#FF85C0', '#7FB3F5', '#FFC2DF'] },
    dusk: { label: 'Dusk', colors: ['#E07B9B', '#D7C4BE', '#5F9BA8', '#9C89B8', '#F0A6CA', '#B8BEDD'] },
    grays: { label: 'Seattle grays', colors: ['#767F8B', '#B3B7B8', '#5C6068', '#D3D3D3', '#989CA3', '#4A4E55', '#C7C9CC'] }
  };

  /** Per-series settings (a measure, a Color member, or both). */
  var SERIES = {
    label: '', // empty → field / member name
    color: '' // empty → palette
  };

  /** One measure on the Line tile. */
  var LINE = {
    label: '',
    color: '', // empty → next palette colour after the bars
    width: 2,
    style: 'solid', // solid | dashed | dotted
    curve: 'straight', // straight | smooth | step
    opacity: 100,
    marker: 'circle', // none | circle | square | diamond | ring
    markerSize: 6,
    markerFill: 'white', // white | line
    area: false,
    areaOpacity: 14,
    labels: false,
    labelSize: 10,
    labelWeight: 600,
    labelPos: 'above', // above | below | right
    fmt: fmtCopy()
  };

  /** A reference line / band on the value axis. */
  var REF = {
    show: true,
    type: 'average', // constant | average | median | min | max | percentile | total
    value: 0,
    percentile: 90,
    scope: 'bars', // bars (all bar values) | series:<key>
    label: '{type}: {value}', // {type} {value} placeholders; empty → no label
    labelPos: 'end', // end | start | center
    color: '#55606E',
    width: 1,
    style: 'dashed',
    bandTo: '', // second type for a band (e.g. min → max); empty → line
    bandOpacity: 10
  };

  var VALUE_SORTS = [['data', 'As in the data'], ['valDesc', 'Value, high to low'], ['valAsc', 'Value, low to high'],
    ['nameAsc', 'Name, A to Z'], ['nameDesc', 'Name, Z to A'], ['date', 'Date (oldest first)'], ['dateDesc', 'Date (newest first)']];
  var BREAKDOWN_ORDERS = [['data', 'Default (as in the data)'], ['valDesc', 'Value, high to low'], ['valAsc', 'Value, low to high'],
    ['desc', 'Size, largest first'], ['asc', 'Size, smallest first'], ['name', 'Name, A to Z'], ['nameDesc', 'Name, Z to A']];

  var DEFAULTS = {
    // ---- Header + card (Icon and Title & text = KPI Card; Card = Waterfall) --
    icon: {
      show: true,
      source: 'builtin', // builtin | upload (shape: older workbooks)
      builtinId: 'fg-bar-chart-solid',
      size: 24,
      color: '#EB644C',
      dataUrl: '',
      name: '',
      mask: false, // upload converted to a one-colour shape: drawn in `color` like the built-ins
      w: 0, // its width and height (for the aspect ratio)
      h: 0
    },
    title: {
      show: true,
      text: '', // empty → the measure names
      align: 'left', // left | center | right
      font: 'Lato',
      size: 16,
      weight: 500,
      color: '#68707D',
      italic: false
    },
    explanation: {
      show: true,
      reserveSpace: false,
      text: '',
      font: 'Lato',
      size: 12,
      weight: 400,
      color: '#68707D',
      italic: true
    },
    card: {
      padding: 15,
      bgColor: '#FFFFFF',
      bgOpacity: 0,
      gap: 0, // space between the header and the chart
      plotBg: '#FFFFFF',
      plotBgOpacity: 0
    },

    // ---- Numbers -----------------------------------------------------------
    numbers: {
      mode: 'all', // all (every part uses `format`; tooltips: tooltip.fmt when tooltip.ownFormat)
      font: 'Lato', // font of all chart text
      nullAs: 'skip' // skip | zero
    },
    format: fmtCopy(),

    // ---- Chart type ----------------------------------------------------------
    chart: {
      orientation: 'vertical', // vertical (columns) | horizontal (bars)
      layout: 'regular', // regular | stacked | stacked100 | diverging | overlap
      barLevel: 1, // how many Dimension fields make the bars; the rest is the breakdown (segments, tooltip, drill-down)
      showAll: false, // bars at every Dimension field (outer ones group them), no double-click needed
      showBars: true, // Bars tab: draw the bars (off: only the lines show)
      showLines: true, // Line Chart tab: draw the Line tile measures
      seriesDims: [],
      panelDims: [],
      panelMeasures: false, // one panel per measure (like Measure Names on Rows / Columns), with 2+ measures
      // Dimension field keys that split the chart into panels (small multiples) // seriesBy 'dims': Dimension field keys whose values (combined) are the series
      seriesBy: 'auto', // auto | measures | dims (seriesDims) | dim (legacy: the last field) — 'dim': the last Dimension field's values are the series (stack, 100%, overlap, left-right)
      style: 'bar', // bar | lollipop | progress
      axisType: 'auto', // auto | dimension | date | measureNames
      overlapOffset: 45, // overlap layout: % of a bar each next series shifts
      animate: true,
      animMs: 350
    },
    progress: {
      max: 'auto', // auto (100% / 1.0 if values look like percentages, else largest) | max | percent | target | fixed
      fixed: 100,
      trackColor: '#E9ECF0',
      trackOpacity: 100,
      trackBorder: false,
      trackBorderColor: '#D5D9DF',
      trackShadow: false, // inner shade on the track (image style "tube")
      showRemaining: false,
      remainingColor: '#8C96A3'
    },
    lollipop: {
      stemWidth: 3,
      stemOpacity: 100,
      head: 'circle', // circle | ring | square | diamond | hexagon | none
      headSize: 14,
      headFill: 'bar', // bar | white | custom
      headColor: '#FFFFFF',
      ringWidth: 3,
      valueInHead: false // value written inside the head (grows to fit)
    },
    diverging: {
      labels: 'axis', // axis (category labels on the axis) | center (between the two sides)
      symmetric: true, // both sides share one scale
      firstSide: 'neg' // neg: first series goes left / down
    },

    // ---- Bars: spacing, shape, fill, border, shadow ---------------------------
    spacing: {
      widthMode: 'pct', // pct (of the category slot) | px
      width: 64, // %
      px: 28,
      seriesGap: 2, // px between bars of the same category (negative = overlap)
      groupGap: 14, // extra px between groups
      edgePad: 50 // % of a gap before the first / after the last category
    },
    shape: {
      radius: 3,
      corners: 'end', // end (value end only) | all | none
      endShape: 'rounded', // rounded | pill | flat | arrow
      arrowDepth: 10
    },
    fill: {
      type: 'solid', // solid | gradient | twoTone
      gradientDir: 'along', // along (base → end) | across
      gradientTo: 'tint', // tint (lighter shade) | color
      gradientColor: '#FFFFFF',
      gradientStrength: 45, // %
      twoTone: 14, // % white over one half
      opacity: 100 // % (transparency)
    },
    border: {
      show: false,
      width: 1,
      colorMode: 'darker', // darker | bar | custom
      color: '#263244',
      opacity: 100,
      style: 'solid'
    },
    shadow: {
      show: false,
      color: '#263244',
      opacity: 18,
      blur: 6,
      dx: 0,
      dy: 2
    },
    hover: {
      dimOthers: true, // fade other bars while hovering one
      dimOpacity: 45,
      outline: false
    },

    // ---- Colours ------------------------------------------------------------
    colors: {
      mode: 'auto', // auto (measures if 2+, else single) | single | measures | dimensions | value | sign | highlight
      dimLevel: 'auto', // dimensions: Dimension field index whose values pick the colour (auto = the bars' level)
      valueField: '__self', // value: __self (the bar's own value) | measure key
      highlightBy: 'auto', // highlight: auto (bar name) | measures | dim:<index>
      paletteEdits: {}, // palette name → edited colours
      single: '#2F4B7C',
      palette: 'house',
      custom: {}, // '<field index>|<value>' → colour (mode dimensions)
      posColor: '#0E7C66',
      negColor: '#B4431E',
      lowColor: '#C6DBEF',
      highColor: '#08519C',
      highlight: [], // highlighted category members
      highlightTop: 0, // highlight the top N (0 = off)
      highlightColor: '#EB644C',
      mutedColor: '#B8C2D0',
      rules: [] // { op: '>' | '>=' | '<' | '<=' | '=', value, color }
    },
    series: {}, // series key → SERIES overrides
    names: {}, // field key → { mode: default | custom | param, text, param }: names of Measure, Line, Target and Tooltip fields

    // ---- Labels (values on the bars) ---------------------------------------
    labels: {
      show: true,
      position: 'outsideEnd', // outsideEnd | insideEnd | center | insideBase | column
      content: 'value', // value | pctTotal | pctCat | valuePct | diffPrev | pctDiffPrev | rank | nameValue
      which: 'all', // all | minmax | max | min | first | last
      size: 11,
      weight: 600,
      italic: false,
      colorMode: 'auto', // auto | bar | blend | custom
      blend: -35, // blend with bar colour: −100 (black) … 100 (white)
      color: '#17202B',
      offset: 4,
      overlap: 'hide', // hide | shrink | none — what to do when labels collide
      insideFallback: true, // inside labels that don't fit move outside
      badge: 'none', // none | circle | ring | pill | rounded | hexagon | diamond | tag
      badgeFill: 'bar', // bar | white | custom
      badgeColor: '#FFFFFF',
      badgeBorder: true,
      segments: true, // stacked: label each segment
      totals: true, // stacked: total at the end of each stack
      totalSize: 11,
      totalWeight: 700,
      totalColor: '#17202B',
      fmt: fmtCopy(),
      totalFmt: fmtCopy()
    },

    // ---- Axes -----------------------------------------------------------------
    axisV: { // value axis
      show: true,
      position: 'auto', // auto (left / bottom) | opposite (right / top)
      base: 'zero', // zero | auto (close to the data) | manual
      padding: 20,
      manualMin: 0,
      maxMode: 'auto', // auto | manual
      manualMax: 100,
      ticks: 5,
      reversed: false,
      title: '',
      font: 'Lato',
      size: 10,
      weight: 400,
      color: '#55606E',
      showLine: false,
      lineColor: '#C9CDD4',
      useGlobalFormat: true,
      fmt: fmtCopy({ decimals: 0 })
    },
    axisC: { // category axis
      show: true,
      position: 'auto', // auto (bottom / left) | opposite (top / right)
      placement: 'axis', // axis | pill (coloured pill under the bar) | above (above the bar end) | insideBase | rotatedInside
      orientation: 'wrap', // wrap | angled | vertical (vertical bars only)
      maxLines: 2,
      maxWidth: 0, // horizontal bars: label column width, 0 = automatic
      align: 'end', // horizontal bars: start | center | end (towards the bar)
      title: '',
      font: 'Lato',
      size: 11,
      weight: 500,
      color: '#17202B',
      colorByBar: false,
      pillRadius: 10,
      showLine: false,
      lineColor: '#C9CDD4',
      lineWidth: 1,
      dateFormat: 'auto', // auto | MMM yyyy | MMM yy | MMM | yyyy | dd MMM | dd/MM/yyyy | yyyy-MM-dd | Qq yyyy
      sort: 'data', // see VALUE_SORTS
      sortBy: '__total', // __total | series key
      hideLabelsAuto: true // skip labels that would overlap
    },
    brk: { // clipped bar marker (axis doesn't start at zero)
      show: true,
      style: 'slash', // slash | zigzag | gap
      pos: 12, // % from the base of the visible bar
      bandColor: '#FFFFFF',
      lineColor: '#55606E'
    },

    // ---- Small multiples (Grouping tab → a field set to Panels) ---------------------------
    panels: {
      layout: 'grid', // grid | rows (one under the other) | columns (side by side)
      columns: 0, // grid: panels per row, 0 = automatic
      shareAxis: true, // one value range for every panel
      showTitle: true,
      titleSize: 12,
      titleWeight: 600,
      titleColor: '#17202B',
      titleAlign: 'left',
      gap: 14
    },

    // ---- Lines (grid, zero, references, targets) ---------------------------------
    lines: {
      valueGrid: { show: true, color: '#ECEEF1', width: 1, style: 'solid' },
      catGrid: { show: false, color: '#ECEEF1', width: 1, style: 'solid' },
      zero: { show: false, color: '#ECEEF1', width: 1, style: 'solid' }
    },
    refs: [], // list of REF
    target: { // Target tile
      show: true,
      style: 'line', // line | dot | triangle | none
      color: '#17202B',
      width: 2,
      extend: 20, // px beyond the bar on each side
      inTooltip: true
    },

    // ---- Line on top of the bars ---------------------------------------------------
    lineDefaults: JSON.parse(JSON.stringify(LINE)),
    lineSeries: {}, // line key → LINE overrides
    lineAxis: {
      mode: 'secondary', // shared (bars' axis) | secondary (own axis)
      show: true,
      base: 'auto', // zero | auto | manual
      manualMin: 0,
      maxMode: 'auto',
      manualMax: 100,
      sync: false, // secondary axis uses the same range as the bars
      title: '',
      size: 10,
      color: '#8C96A3',
      useGlobalFormat: true,
      fmt: fmtCopy({ decimals: 0 })
    },

    // ---- Legend ----------------------------------------------------------------------
    legend: {
      show: true,
      position: 'top', // top | bottom | left | right
      align: 'start', // start | center | end
      marker: 'square', // square | rounded | circle | line | bar
      markerSize: 10,
      font: 'Lato',
      size: 11,
      weight: 400,
      color: '#55606E',
      showTitle: false,
      title: '',
      interactive: true, // click an item to hide / show it
      hoverHighlight: true, // hover an item to highlight its bars
      showValues: false, // total next to each name
      sort: 'data', // data | name | valDesc
      includeLines: true,
      includeRefs: false,
      includeTarget: true,
      gap: 14,
      box: false,
      boxColor: '#FFFFFF',
      boxBorder: '#E2E4E8',
      autoHide: true, // hide when there is only one item
      topNNames: 'both', // Top N + Others items: both ("Sales – Top 10") | group ("Top 10")
      names: {} // legend item id → custom name (may hold <Parameter>)
    },

    // ---- Icons for dimension members --------------------------------------------------------
    icons: {
      show: false,
      placement: 'axis', // axis | base | middle | end | outside | above
      size: 18,
      bg: 'none', // none | square | rounded | circle
      bgMode: 'bar', // bar | tint | custom
      bgColor: '#F2F4F7',
      tint: 'auto', // auto (white on a coloured background, else bar colour) | bar | white | custom | original
      color: '#263244',
      accent: false, // short coloured bar next to an axis icon
      gap: 6,
      fallback: '', // built-in icon id for members without their own ('' = none)
      by: 'auto', // what each bar is: auto (its name) | measures | dim:<index>
      members: {} // member → { source: builtin|upload|shape, builtinId, dataUrl, name }
    },

    // ---- Top N ----------------------------------------------------------------------------
    topN: {
      enabled: false,
      n: 10,
      level: 'auto', // Dimension field index to rank (auto = the bars' level)
      scope: 'parent', // parent (within each value of the field before it) | overall (across all)
      by: '__total', // __total (all measures) | measure key
      direction: 'top', // top | bottom
      others: true,
      othersAgg: 'sum', // sum | avg (use avg for averages and ratios)
      label: 'Others',
      color: '#B8BEC7',
      othersLast: true
    },

    // ---- Groups ---------------------------------------------------------------------------
    groups: {
      mode: 'auto', // auto (outer Axis fields and drill parents) | custom | none
      custom: {}, // id → { text, color }
      assignBy: 'auto', // what each bar is: auto (its name) | measures | dim:<index>
      assign: {}, // member → group id
      lineStyle: 'bracket', // solid | dashed | dotted | bracket | none
      lineWidth: 1,
      color: '#8C96A3',
      size: 11,
      weight: 600,
      textColor: '#55606E',
      showTotal: false,
      separator: ' · ',
      band: false,
      bandOpacity: 5,
      fmt: fmtCopy()
    },

    // ---- Breakdown (Waterfall style) --------------------------------------------------------
    breakdown: {
      show: false, // split bars into segments by the Breakdown fields
      dims: [], // Breakdown fields used for segments, in name order (empty → all)
      sep: ' · ',
      colorMode: 'shades', // shades | custom
      colors: {},
      dividers: true,
      showValues: false,
      showNames: false,
      position: 'inside', // inside | right | left
      size: 10,
      weight: 400,
      labelColorMode: 'auto',
      labelColor: '#17202B',
      minPx: 12,
      order: 'valDesc',
      fmt: fmtCopy()
    },

    // ---- Drill down --------------------------------------------------------------------------
    drill: {
      enabled: true,
      mode: 'expandOne', // expandOne | focus | expandAll
      tintChildren: true,
      showBar: true // breadcrumb / back bar above the chart while drilled
    },

    // ---- Tooltip + interaction ----------------------------------------------------------------
    tooltip: {
      show: true,
      sort: 'valDesc', // data | valDesc | valAsc | name | nameDesc
      showPct: true,
      showSeries: true,
      showBreakdown: true,
      showExtra: true, // Tooltip tile fields (dimensions and measures) as name: value
      showLines: true,
      maxRows: 15,
      fullNumbers: true, // full numbers (Tableau's format when available)
      pinOnClick: false, // click a bar: tooltip stays, breakdown can be sorted
      ownFormat: false, // tooltip numbers: false = the chart's number format, true = fmt below
      fmt: fmtCopy()
    },
    interaction: {
      rightClickMenu: true,
      dblclick: 'drill', // drill | format | none
      selectInTableau: true, // click a bar, its value or its name selects the category in Tableau (dashboard actions); click again or on empty space to undo
      hidden: [] // category / series keys hidden from the right-click menu
    },

    // ---- Comments -----------------------------------------------------------------------------
    comments: {
      show: true,
      display: 'marker', // marker (hover to read) | callout (text always visible)
      marker: 'dot', // dot | flag | pin | bubble
      color: '#EB644C',
      size: 11,
      maxWidth: 160,
      author: '',
      items: {} // bar key → [{ id, text, author, date, color }]
    },

    // Last seen fields (for renamed pills)
    layout: { series: [], lines: [] }
  };

  // -------------------------------------------------------------------------
  // Built-in icons: only the Figma "Icons for Extension" set (icons.js).
  // -------------------------------------------------------------------------
  var ICONS = (window.KPI3_FIGMA_ICONS || []).map(function (ic) {
    var o = {}; for (var k in ic) o[k] = ic[k]; o.figma = true; return o;
  });

  var ICON_GROUPS = ['Chart icons', 'Others'];

  function findIcon (id) {
    var fallback = ICONS[0];
    for (var i = 0; i < ICONS.length; i++) {
      if (ICONS[i].id === id) return ICONS[i];
      if (ICONS[i].id === DEFAULTS.icon.builtinId) fallback = ICONS[i];
    }
    return fallback;
  }

  function iconSize (icon, target) {
    var t = Number(target) > 0 ? Number(target) : 24;
    var w = icon.w || 24;
    var h = icon.h || 24;
    return w >= h
      ? { w: t, h: Math.max(1, Math.round(t * h / w)) }
      : { w: Math.max(1, Math.round(t * w / h)), h: t };
  }

  function iconHtml (id, color, target) {
    var icon = findIcon(id);
    var size = iconSize(icon, target);
    var html;
    if (icon.src) {
      if (icon.tint) {
        var m = 'url(' + icon.src + ') center / contain no-repeat';
        html = '<span class="kpi3-icon-mask" style="display:block;width:' + size.w + 'px;height:' + size.h +
          'px;background-color:' + color + ';-webkit-mask:' + m + ';mask:' + m + '"></span>';
      } else {
        html = '<img src="' + icon.src + '" alt="" width="' + size.w + '" height="' + size.h +
          '" style="display:block;width:' + size.w + 'px;height:' + size.h + 'px">';
      }
    } else {
      var paint = icon.mode === 'stroke'
        ? 'fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
        : 'fill="' + color + '"';
      html = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size.w + '" height="' + size.h + '" viewBox="0 0 24 24" style="display:block">' +
        '<path ' + paint + ' d="' + icon.d + '"/></svg>';
    }
    return { html: html, w: size.w, h: size.h, icon: icon };
  }

  function iconSvg (id, color) { return iconHtml(id, color).html; }

  // -------------------------------------------------------------------------
  // Settings I/O
  // -------------------------------------------------------------------------
  function clone (o) { return JSON.parse(JSON.stringify(o)); }

  function isMap (o) { return o && typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length; }

  /**
   * Deep-merges stored values over the defaults so new keys get defaults.
   * An empty object in the defaults ({}) is a map: the stored map is copied as
   * is. Arrays are copied as stored.
   */
  function merge (base, over) {
    var out = clone(base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(out).forEach(function (k) {
      if (!(k in over)) return;
      if (isMap(out[k])) {
        if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) out[k] = clone(over[k]);
      } else if (Array.isArray(out[k])) {
        if (Array.isArray(over[k])) out[k] = clone(over[k]);
      } else if (out[k] && typeof out[k] === 'object') {
        out[k] = merge(out[k], over[k]);
      } else if (typeof over[k] === typeof out[k] || out[k] === '' || out[k] == null) {
        out[k] = over[k];
      }
    });
    return out;
  }

  function read () {
    try {
      var raw = tableau.extensions.settings.get(STORAGE_KEY);
      return merge(DEFAULTS, raw ? JSON.parse(raw) : null);
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  function write (cfg) {
    tableau.extensions.settings.set(STORAGE_KEY, JSON.stringify(cfg));
    return tableau.extensions.settings.saveAsync();
  }

  function seriesCfg (cfg, key) { return merge(SERIES, cfg.series[key]); }
  function lineCfg (cfg, key) { return merge(cfg.lineDefaults, cfg.lineSeries[key]); }
  function refCfg (r) { return merge(REF, r); }

  // -------------------------------------------------------------------------
  // Number formatting
  // -------------------------------------------------------------------------
  var SCALES = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

  function pickScale (value, scale) {
    if (scale === 'dynamic') {
      var a = Math.abs(value);
      return a >= 1e12 ? 'T' : a >= 1e9 ? 'B' : a >= 1e6 ? 'M' : a >= 1e3 ? 'K' : '';
    }
    return SCALES[scale] ? scale : '';
  }

  var NF_CACHE = {}; // Intl.NumberFormat is slow to create: one per (decimals, grouping)
  function fixed (n, decimals, thousands) {
    var d = Math.max(0, Math.min(10, Number(decimals) || 0));
    var key = d + (thousands !== false ? 'g' : 'n');
    try {
      var nf = NF_CACHE[key] || (NF_CACHE[key] = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
        useGrouping: thousands !== false
      }));
      return nf.format(n);
    } catch (e) {
      return n.toFixed(d);
    }
  }

  function formatScaled (value, scale, decimals, forceScale, thousands) {
    if (!isFinite(value)) return '—';
    var suffix = forceScale != null ? forceScale : pickScale(value, scale);
    var divisor = SCALES[suffix] || 1;
    var text = fixed(value / divisor, decimals, thousands);
    if (/^-[0.,]+$/.test(text)) text = text.slice(1);
    return text + suffix;
  }

  /**
   * Formats a number with a format object (see FORMAT).
   *   opts.signed      write "+" on positive values (when the format asks for it)
   *   opts.fv          Tableau's formatted value (Workbook format)
   *   opts.forceScale  reuse a K/M/B suffix (axis ticks share one)
   *   opts.noUnit      leave the unit off
   *   opts.abs         drop the sign (diverging axis)
   *   opts.full        no K/M/B (tooltips)
   */
  function formatNumber (v, f, opts) {
    opts = opts || {};
    f = f || FORMAT;
    if (v == null || !isFinite(v)) return '—';
    if (opts.abs) v = Math.abs(v);
    var body;
    var neg = v < 0;
    var a = Math.abs(v);
    var scale = f.scale;
    if (opts.full) {
      if (scale === 'workbook' && opts.fv) return String(opts.fv);
      if (scale === 'percentDynamic') scale = 'percent';
      else if (scale !== 'percent') scale = 'none';
    }
    var dec = f.decimals;
    if (opts.full && scale === 'none' && a !== Math.round(a)) dec = Math.max(dec, 2);
    if (scale === 'percent' || scale === 'percentDynamic') {
      var p = f.pctFromRatio ? a * 100 : a;
      body = formatScaled(p, scale === 'percentDynamic' ? 'dynamic' : 'none', dec,
        scale === 'percentDynamic' ? opts.forceScale : '', f.thousands) + '%';
    } else if (scale === 'workbook' && opts.fv) {
      body = String(opts.fv).replace(/^[-−(]\s*/, '').replace(/\)$/, '');
    } else {
      var sc = scale === 'workbook' ? 'dynamic' : scale;
      body = formatScaled(a, sc, dec, opts.forceScale, f.thousands);
    }
    if (!/[1-9]/.test(body)) neg = false;
    if (!opts.noUnit && f.unit) {
      var sp = f.unitSpace === false ? '' : ' ';
      body = f.unitPosition === 'prefix' ? f.unit + sp + body : body + sp + f.unit;
    }
    if (neg) {
      if (f.negStyle === 'paren') return '(' + body + ')';
      return (f.negStyle === 'hyphen' ? '-' : '−') + body;
    }
    if (opts.signed && f.plusSign && /[1-9]/.test(body)) return '+' + body;
    return body;
  }

  // -------------------------------------------------------------------------
  // Dates
  // -------------------------------------------------------------------------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** Date from a Tableau cell value (Date, ISO text, "2024", "Jan 2024", "Q1 2024", "January"…). */
  function parseDate (v) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (v == null) return null;
    if (typeof v === 'number') {
      if (v >= 1000 && v <= 9999) return new Date(v, 0, 1);
      return null;
    }
    var s = String(v).trim();
    var m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return new Date(+m[1], +m[2] - 1, +m[3]);
    if ((m = /^(\d{4})$/.exec(s))) return new Date(+m[1], 0, 1);
    if ((m = /^Q([1-4])\s*[-/ ]?\s*(\d{4})$/i.exec(s))) return new Date(+m[2], (+m[1] - 1) * 3, 1);
    if ((m = /^(\d{4})\s*[-/ ]?\s*Q([1-4])$/i.exec(s))) return new Date(+m[1], (+m[2] - 1) * 3, 1);
    if ((m = /^Q([1-4])$/i.exec(s))) return new Date(2000, (+m[1] - 1) * 3, 1);
    var mi = monthIndex(s.split(/[\s,-]+/)[0]);
    if (mi >= 0) {
      var y = /(\d{4})/.exec(s);
      var yy = /\b(\d{2})$/.exec(s);
      return new Date(y ? +y[1] : yy ? 2000 + +yy[1] : 2000, mi, 1);
    }
    if ((m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(s))) {
      // Ambiguous d/m vs m/d: Tableau's US format is m/d.
      var a = +m[1]; var b = +m[2];
      return a > 12 ? new Date(+m[3], b - 1, a) : new Date(+m[3], a - 1, b);
    }
    var t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }

  function monthIndex (s) {
    var k = String(s || '').slice(0, 3).toLowerCase();
    for (var i = 0; i < 12; i++) if (MONTHS[i].toLowerCase() === k) return i;
    return -1;
  }

  function pad2 (n) { return (n < 10 ? '0' : '') + n; }

  function formatDate (d, pattern) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    return pattern.replace(/yyyy|yy|MMMM|MMM|MM|dd|Qq|q/g, function (t) {
      switch (t) {
        case 'yyyy': return String(d.getFullYear());
        case 'yy': return pad2(d.getFullYear() % 100);
        case 'MMMM': return MONTHS_LONG[d.getMonth()];
        case 'MMM': return MONTHS[d.getMonth()];
        case 'MM': return pad2(d.getMonth() + 1);
        case 'dd': return pad2(d.getDate());
        case 'Qq': return 'Q' + (Math.floor(d.getMonth() / 3) + 1);
        case 'q': return String(Math.floor(d.getMonth() / 3) + 1);
      }
      return t;
    });
  }

  var DATE_FORMATS = [['auto', 'As Tableau writes it'], ['MMM yyyy', 'Jan 2026'], ['MMM yy', 'Jan 26'], ['MMM', 'Jan'],
    ['MMMM', 'January'], ['yyyy', '2026'], ['Qq yyyy', 'Q1 2026'], ['dd MMM', '05 Jan'], ['dd MMM yyyy', '05 Jan 2026'],
    ['dd/MM/yyyy', '05/01/2026'], ['MM/dd/yyyy', '01/05/2026'], ['yyyy-MM-dd', '2026-01-05']];

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------
  function comparer (order, val, name) {
    var byName = function (a, b) { return String(name(a)).localeCompare(String(name(b)), undefined, { numeric: true, sensitivity: 'base' }); };
    switch (order) {
      case 'valDesc': return function (a, b) { return val(b) - val(a); };
      case 'valAsc': return function (a, b) { return val(a) - val(b); };
      case 'desc': return function (a, b) { return Math.abs(val(b)) - Math.abs(val(a)); };
      case 'asc': return function (a, b) { return Math.abs(val(a)) - Math.abs(val(b)); };
      case 'name': case 'nameAsc': return byName;
      case 'nameDesc': return function (a, b) { return byName(b, a); };
      default: return null;
    }
  }

  function sortBy (list, cmp) {
    if (!cmp) return list.slice();
    return list.map(function (x, i) { return { x: x, i: i }; })
      .sort(function (a, b) { return cmp(a.x, b.x) || a.i - b.i; })
      .map(function (o) { return o.x; });
  }

  // -------------------------------------------------------------------------
  // Colours
  // -------------------------------------------------------------------------
  function fontStack (family) {
    if (!family) return FONT_STACK_FALLBACK;
    return '"' + String(family).replace(/"/g, '') + '", ' + FONT_STACK_FALLBACK;
  }

  function normalizeHex (value) {
    if (typeof value !== 'string') return null;
    var hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/(.)/g, '$1$1');
    return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : null;
  }

  function rgb (hex) {
    var h = normalizeHex(hex) || '#000000';
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function toHex (c) {
    return '#' + c.map(function (x) { return ('0' + Math.max(0, Math.min(255, Math.round(x))).toString(16)).slice(-2); }).join('').toUpperCase();
  }

  function rgba (hex, alpha) {
    var c = rgb(hex);
    return 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + alpha + ')';
  }

  /** Mixes two colours: t = 0 → a, t = 1 → b. */
  function mix (a, b, t) {
    var x = rgb(a); var y = rgb(b);
    return toHex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; }));
  }

  function tint (hex, t) { return mix(hex, '#FFFFFF', t); }

  /** −100 … 100: towards black … towards white. */
  function blend (hex, amount) {
    var a = Math.max(-100, Math.min(100, Number(amount) || 0)) / 100;
    return a < 0 ? mix(hex, '#000000', -a) : mix(hex, '#FFFFFF', a);
  }

  function luminance (hex) {
    var c = rgb(hex).map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrastText (hex) { return luminance(hex) > 0.36 ? '#17202B' : '#FFFFFF'; }

  /** Readable version of a bar colour for text on a light background. */
  function readable (hex) { return luminance(hex) > 0.45 ? mix(hex, '#000000', 0.45) : hex; }

  function shades (hex, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(tint(hex, n <= 1 ? 0 : (i / (n - 1)) * 0.62));
    return out;
  }

  /** Palette colours, with any colours edited in the Format dialog (edits: name → [colour | null]). */
  function paletteColors (name, edits) {
    var base = (PALETTES[name] || PALETTES.house).colors.slice();
    var e = edits && edits[name];
    if (Array.isArray(e)) e.forEach(function (c, i) { if (i < base.length && normalizeHex(c)) base[i] = normalizeHex(c); });
    return base;
  }

  function dashArray (style, width) {
    var w = Math.max(0.5, Number(width) || 1);
    if (style === 'dashed') return (3 * w) + ',' + (3 * w);
    if (style === 'dotted') return w + ',' + (2 * w);
    return '';
  }

  window.Bc = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    FORMAT: FORMAT,
    SERIES: SERIES,
    LINE: LINE,
    REF: REF,
    PALETTES: PALETTES,
    VALUE_SORTS: VALUE_SORTS,
    BREAKDOWN_ORDERS: BREAKDOWN_ORDERS,
    DATE_FORMATS: DATE_FORMATS,
    FONTS: FONTS,
    ICONS: ICONS,
    ICON_GROUPS: ICON_GROUPS,
    findIcon: findIcon,
    iconHtml: iconHtml,
    iconSvg: iconSvg,
    clone: clone,
    merge: merge,
    read: read,
    write: write,
    fmtCopy: fmtCopy,
    seriesCfg: seriesCfg,
    lineCfg: lineCfg,
    refCfg: refCfg,
    pickScale: pickScale,
    fixed: fixed,
    formatScaled: formatScaled,
    formatNumber: formatNumber,
    parseDate: parseDate,
    formatDate: formatDate,
    comparer: comparer,
    sortBy: sortBy,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba,
    mix: mix,
    tint: tint,
    blend: blend,
    luminance: luminance,
    shades: shades,
    contrastText: contrastText,
    readable: readable,
    paletteColors: paletteColors,
    dashArray: dashArray
  };
  window.Kpi3 = window.Kpi3 || window.Bc;
})();
