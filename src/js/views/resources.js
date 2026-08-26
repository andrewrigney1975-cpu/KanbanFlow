"use strict";
import { toast } from '../ui.js';
import { portfolioApi, isOrgAdmin } from '../api.js';
import { escapeHTML } from '../utils.js';
import { iconSvg } from '../icons.js';
import { memberColorForIndex } from '../date-utils.js';
import { buildTimelineColumns, tlDateToPixel } from './timeline.js';
import { noDatesPatternDefsSVG } from '../portfolio-bars.js';

/* =========================================================
   RESOURCES — Org-Admin-only, org-wide (see root CLAUDE.md's Resources view note): a Gantt-style
   chart plotting every team member's % allocation to every project ("activity") they're on, over
   time. Bars use each project's own StartDate/EndDate — there's no per-assignment date range in
   this schema, so a member's bar for a project spans the project's whole life. Data comes from
   portfolioApi.listResourceAssignments() (all three backend tiers, OrgAdmin-gated, independently
   re-derived against the caller's org server-side — nothing here trusts a client-side id).

   Groupable by person (rows = members, bars = their various project allocations) or by activity
   (rows = projects, bars = the people allocated to them, including unfilled placeholder roles).
   Either way, within a row, overlapping-in-time bars are packed into separate vertical "lanes" via
   assignRowLanes (a plain greedy interval-graph coloring — no existing chart primitive in this app
   does this, everything else here plots one bar per row).

   The reporting period (the "current date window" the red-flag/alert logic and the chart's own x-
   axis both use) is an explicit, user-editable start/end pair — not derived from the data — defaulting
   to the current calendar quarter on first open, same as a rolling report would. Editable via
   resourcesStartInput/resourcesEndInput (see onResourcesRangeChanged), with a "This quarter" reset
   button for getting back to the default. This is a deliberate departure from Portfolio Planner's own
   chart, which defaults its range by fitting the data — a resourcing report needs a stable, predictable
   period the viewer chose, not one that silently shifts as projects are added/removed.
   ========================================================= */

var _assignments = [];
var _state = {groupBy: 'person', granularity: 'month', start: null, end: null};
var _overlapByUser = {}; // userId -> [{start: Date, end: Date, peak: number}]

export function openResourcesOverlay(){
  if(!isOrgAdmin()){ toast('Only an organisation admin can open Resources.'); return; }
  document.getElementById('resourcesOverlay').classList.remove('hidden');
  loadResourcesDataAndRender();
}
export function closeResourcesOverlay(){
  document.getElementById('resourcesOverlay').classList.add('hidden');
  closeResourcesPopover();
}
export function isResourcesOverlayOpen(){
  return !document.getElementById('resourcesOverlay').classList.contains('hidden');
}

function loadResourcesDataAndRender(){
  var chartEl = document.getElementById('resourcesChart');
  chartEl.innerHTML = '<div class="kf-health-empty">Loading…</div>';
  document.getElementById('resourcesNoData').classList.add('hidden');
  portfolioApi.listResourceAssignments().then(function(data){
    _assignments = data || [];
    if(!_state.start || !_state.end){
      var range = computePeriodRange('quarter');
      _state.start = range.start;
      _state.end = range.end;
    }
    computeOverlaps();
    renderResourcesAll();
  }, function(){
    chartEl.innerHTML = '';
    var noDataEl = document.getElementById('resourcesNoData');
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = 'Could not load Resources data.';
  });
}

/* Quick-period picker (resourcesPeriodPickerSelect) — every option is relative to today, not to the
   currently-plotted data, same "stable, predictable period" reasoning as this file's header comment.
   'quarter' is also the reporting period's own default on first open (see loadResourcesDataAndRender). */
function computePeriodRange(period){
  var now = new Date(), y = now.getFullYear(), m = now.getMonth();
  if(period === 'month') return {start: new Date(y, m, 1), end: new Date(y, m + 1, 0)};
  if(period === 'half'){
    var hStartMonth = m < 6 ? 0 : 6;
    return {start: new Date(y, hStartMonth, 1), end: new Date(y, hStartMonth + 6, 0)};
  }
  if(period === 'year') return {start: new Date(y, 0, 1), end: new Date(y, 11, 31)};
  if(period === 'nextyear') return {start: new Date(y + 1, 0, 1), end: new Date(y + 1, 11, 31)};
  // 'quarter' (and any unrecognized value) — Jan-Mar/Apr-Jun/Jul-Sep/Oct-Dec, whichever contains today.
  var qStartMonth = Math.floor(m / 3) * 3;
  return {start: new Date(y, qStartMonth, 1), end: new Date(y, qStartMonth + 3, 0)};
}
function toServerDateOnly(date){
  var y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

/* Sweep-line over +AllocatedFraction at an assignment's start and -AllocatedFraction at its end,
   clipped to [rangeStart, rangeEnd] — any interval where the running total exceeds 100 is an
   overlap window. Assignments outside the range entirely are skipped; ones that only partly overlap
   it are clipped to it, so a window never extends past the currently-plotted range. */
export function computeOverlapWindows(assignments, rangeStart, rangeEnd){
  var events = [];
  assignments.forEach(function(a){
    var s = new Date(a.projectStartDate).getTime();
    var e = new Date(a.projectEndDate).getTime();
    if(e <= rangeStart.getTime() || s >= rangeEnd.getTime()) return;
    events.push({t: Math.max(s, rangeStart.getTime()), delta: a.allocatedFraction});
    events.push({t: Math.min(e, rangeEnd.getTime()), delta: -a.allocatedFraction});
  });
  events.sort(function(x, y){ return x.t - y.t; });
  var windows = [], running = 0, windowStart = null, peak = 0;
  events.forEach(function(ev){
    var before = running;
    running += ev.delta;
    if(before <= 100 && running > 100){
      windowStart = ev.t;
      peak = running;
    } else if(before > 100 && running > 100){
      if(running > peak) peak = running;
    } else if(before > 100 && running <= 100){
      windows.push({start: new Date(windowStart), end: new Date(ev.t), peak: peak});
      windowStart = null;
      peak = 0;
    }
  });
  return windows;
}

function computeOverlaps(){
  _overlapByUser = {};
  if(!_state.start || !_state.end) return;
  var byUser = {};
  _assignments.forEach(function(a){
    if(!a.userId || !a.projectStartDate || !a.projectEndDate) return;
    (byUser[a.userId] = byUser[a.userId] || []).push(a);
  });
  Object.keys(byUser).forEach(function(userId){
    var windows = computeOverlapWindows(byUser[userId], _state.start, _state.end);
    if(windows.length) _overlapByUser[userId] = windows;
  });
}

function formatDate(date){
  return date.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
}
function formatDateStr(dateStr){
  return dateStr ? formatDate(new Date(dateStr)) : '—';
}

function renderResourcesAll(){
  renderResourcesAlert();
  renderResourcesControls();
  renderResourcesChart();
  renderResourcesUndatedNote();
}

/* Opening-alert summary — every member with at least one overlap window in the current date window,
   with the range(s) and peak concurrent % they hit. Hidden entirely when nobody is over-allocated. */
function renderResourcesAlert(){
  var el = document.getElementById('resourcesOverlapAlert');
  var userIds = Object.keys(_overlapByUser);
  if(userIds.length === 0){ el.classList.add('hidden'); el.innerHTML = ''; return; }

  var namesById = {};
  _assignments.forEach(function(a){ if(a.userId) namesById[a.userId] = a.displayName; });

  // Sorted worst-first (highest peak %) — this is a triage list, so the person most over-allocated
  // should be the first thing a reader sees, not buried alphabetically. Ties broken by name so the
  // order stays stable/predictable when several people share the same peak.
  var rows = userIds.map(function(uid){
    var windows = _overlapByUser[uid];
    var peak = Math.max.apply(null, windows.map(function(w){ return w.peak; }));
    var rangeText = windows.map(function(w){ return formatDate(w.start) + '–' + formatDate(w.end); }).join(', ');
    return {name: namesById[uid] || 'Unknown', peak: peak, rangeText: rangeText};
  }).sort(function(x, y){ return y.peak - x.peak || x.name.localeCompare(y.name); });

  var itemsHTML = rows.map(function(r){
    return '<div class="kf-resources-alert-row">' +
      '<span class="kf-resources-alert-name">' + escapeHTML(r.name) + '</span>' +
      '<span class="kf-resources-alert-peak">up to ' + r.peak + '%</span>' +
      '<span class="kf-resources-alert-range">' + escapeHTML(r.rangeText) + '</span>' +
      '</div>';
  }).join('');

  el.classList.remove('hidden');
  el.innerHTML = '<span class="kf-icon kf-resources-alert-icon">' + iconSvg('warning', 18) + '</span>' +
    '<div class="kf-resources-alert-body"><div class="kf-resources-alert-title">' + userIds.length + ' team member' + (userIds.length === 1 ? '' : 's') + ' over-allocated in this date range</div>' +
    '<div class="kf-resources-alert-list">' + itemsHTML + '</div></div>';
  wireResourcesAlertHover();
}

/* Hovering one row dims every other row, so a reader tracking one person's row across a long list
   isn't distracted by the rest. Wired once against the never-replaced #resourcesOverlapAlert
   container (only its innerHTML changes on re-render) — same "stable container, delegated listener"
   convention as wireResourcesBarHover/openTaskDepPopover elsewhere in this app. */
var resourcesAlertHoverWired = false;
function wireResourcesAlertHover(){
  if(resourcesAlertHoverWired) return;
  resourcesAlertHoverWired = true;
  var el = document.getElementById('resourcesOverlapAlert');
  el.addEventListener('mouseover', function(e){
    var row = e.target.closest('.kf-resources-alert-row');
    if(!row) return;
    el.classList.add('kf-resources-alert-hovering');
    el.querySelectorAll('.kf-resources-alert-row').forEach(function(r){
      r.classList.toggle('kf-resources-alert-row-active', r === row);
    });
  });
  el.addEventListener('mouseleave', function(){
    el.classList.remove('kf-resources-alert-hovering');
    el.querySelectorAll('.kf-resources-alert-row').forEach(function(r){ r.classList.remove('kf-resources-alert-row-active'); });
  });
}

function renderResourcesControls(){
  document.getElementById('resourcesScaleSelect').value = _state.granularity;
  document.getElementById('resourcesGroupByPersonBtn').classList.toggle('kf-active', _state.groupBy === 'person');
  document.getElementById('resourcesGroupByActivityBtn').classList.toggle('kf-active', _state.groupBy === 'activity');
  if(_state.start) document.getElementById('resourcesStartInput').value = toServerDateOnly(_state.start);
  if(_state.end) document.getElementById('resourcesEndInput').value = toServerDateOnly(_state.end);
}
export function onResourcesScaleChanged(){
  _state.granularity = document.getElementById('resourcesScaleSelect').value;
  renderResourcesChart();
}
/* The reporting period's start/end directly drive both the chart's x-axis AND the overlap/red-flag
   math (computeOverlaps reads _state.start/end) — so changing either input needs a full recompute,
   not just a re-render, or the alert/flags would keep reflecting the previous period. */
export function onResourcesRangeChanged(){
  var startInput = document.getElementById('resourcesStartInput');
  var endInput = document.getElementById('resourcesEndInput');
  if(startInput.value) _state.start = new Date(startInput.value + 'T00:00:00');
  if(endInput.value) _state.end = new Date(endInput.value + 'T00:00:00');
  computeOverlaps();
  renderResourcesAlert();
  renderResourcesChart();
}
export function onResourcesPeriodPickerChanged(){
  var period = document.getElementById('resourcesPeriodPickerSelect').value;
  var range = computePeriodRange(period);
  _state.start = range.start;
  _state.end = range.end;
  renderResourcesControls();
  computeOverlaps();
  renderResourcesAlert();
  renderResourcesChart();
}
export function onResourcesGroupByPersonClick(){
  _state.groupBy = 'person';
  renderResourcesControls();
  renderResourcesChart();
}
export function onResourcesGroupByActivityClick(){
  _state.groupBy = 'activity';
  renderResourcesControls();
  renderResourcesChart();
}

function distinctIndex(items, keyFn){
  var idx = {}, i = 0;
  items.forEach(function(item){
    var k = keyFn(item);
    if(!(k in idx)) idx[k] = i++;
  });
  return idx;
}

/* An assignment is "in" the current reporting period if its (dated) project range overlaps
   [_state.start, _state.end] at all — same inclusion rule computeOverlapWindows already applies to
   the overlap math, kept consistent here so the chart only ever plots what the alert/flags actually
   reasoned about. Undated assignments never intersect any window (see renderResourcesUndatedNote for
   where they're surfaced instead). */
function assignmentInWindow(a){
  if(!a.projectStartDate || !a.projectEndDate || !_state.start || !_state.end) return false;
  var s = new Date(a.projectStartDate).getTime(), e = new Date(a.projectEndDate).getTime();
  return e > _state.start.getTime() && s < _state.end.getTime();
}

/* Rows = members (real ProjectMembers only — a placeholder has no person to group under in this
   mode). Bars = each of that member's project assignments, colored by project (a stable index
   across every distinct project in the dataset — not just the current window, so a project's color
   doesn't shift as the reporting period changes — via the same indexed palette memberColorForIndex
   uses elsewhere, reused generically here, not as a "member" color). */
function buildPersonRows(){
  var windowed = _assignments.filter(assignmentInWindow);
  var byUser = {};
  windowed.forEach(function(a){
    if(!a.userId) return;
    if(!byUser[a.userId]) byUser[a.userId] = {key: a.userId, label: a.displayName, hasFlag: !!_overlapByUser[a.userId], items: []};
    byUser[a.userId].items.push(a);
  });
  var projectIndex = distinctIndex(_assignments, function(a){ return a.projectId; });
  return Object.keys(byUser).map(function(k){ return byUser[k]; })
    .sort(function(x, y){ return x.label.localeCompare(y.label); })
    .map(function(row){
      row.bars = row.items.map(function(a){ return {a: a, color: memberColorForIndex(projectIndex[a.projectId])}; });
      return row;
    });
}

/* Rows = projects ("activities"), restricted to the current reporting period same as buildPersonRows.
   Bars = every assignee on that project, real members and unfilled/filled placeholder rows alike,
   colored by a per-row index over distinct assignees (a placeholder with no user is keyed by its own
   role text, so two different unfilled roles on the same project still get distinct colors). hasFlag
   looks up the same _overlapByUser map as the person grouping, so a member's row-label flag stays
   consistent regardless of which grouping mode is active. */
function buildActivityRows(){
  var windowed = _assignments.filter(assignmentInWindow);
  var byProject = {};
  windowed.forEach(function(a){
    if(!byProject[a.projectId]) byProject[a.projectId] = {key: a.projectId, label: a.projectName + ' (' + a.projectKey + ')', hasFlag: false, items: []};
    byProject[a.projectId].items.push(a);
    if(a.userId && _overlapByUser[a.userId]) byProject[a.projectId].hasFlag = true;
  });
  return Object.keys(byProject).map(function(k){ return byProject[k]; })
    .sort(function(x, y){ return x.label.localeCompare(y.label); })
    .map(function(row){
      var memberIndex = distinctIndex(row.items, function(a){ return a.userId || ('placeholder:' + a.role); });
      row.bars = row.items.map(function(a){ return {a: a, color: memberColorForIndex(memberIndex[a.userId || ('placeholder:' + a.role)])}; });
      return row;
    });
}

/* Greedy interval-graph lane packing: sort a row's dated bars by start, place each into the first
   lane whose last-placed bar doesn't overlap it, else open a new lane. Undated bars can't be time-
   placed at all and are dropped here (see renderResourcesUndatedNote for where they DO show up). */
export function assignRowLanes(bars){
  var dated = bars.filter(function(b){ return b.a.projectStartDate && b.a.projectEndDate; })
    .slice()
    .sort(function(x, y){ return new Date(x.a.projectStartDate).getTime() - new Date(y.a.projectStartDate).getTime(); });
  var laneEnds = [];
  dated.forEach(function(b){
    var s = new Date(b.a.projectStartDate).getTime();
    var e = new Date(b.a.projectEndDate).getTime();
    var lane = laneEnds.findIndex(function(end){ return end <= s; });
    if(lane === -1){ lane = laneEnds.length; laneEnds.push(e); }
    else { laneEnds[lane] = e; }
    b.lane = lane;
  });
  return {bars: dated, laneCount: Math.max(laneEnds.length, 1)};
}

var RESOURCES_NAME_COL_WIDTH = 200, RESOURCES_LANE_HEIGHT = 22, RESOURCES_ROW_PADDING = 6, RESOURCES_MARGIN_TOP = 40;

function renderResourcesChart(){
  var chartEl = document.getElementById('resourcesChart');
  var noDataEl = document.getElementById('resourcesNoData');

  if(!_state.start || !_state.end){
    chartEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = 'Set a start and end date above to plot the chart.';
    return;
  }

  var rows = (_state.groupBy === 'activity' ? buildActivityRows() : buildPersonRows())
    .map(function(row){
      var packed = assignRowLanes(row.bars);
      return {key: row.key, label: row.label, hasFlag: row.hasFlag, bars: packed.bars, laneCount: packed.laneCount};
    })
    .filter(function(row){ return row.bars.length > 0; });

  if(rows.length === 0){
    chartEl.innerHTML = '';
    noDataEl.classList.remove('hidden');
    noDataEl.textContent = _assignments.length === 0
      ? 'No allocated team members found in this organisation yet.'
      : 'No dated allocations to plot for the selected reporting period — see the undated allocations list below, or widen the date range above.';
    return;
  }
  noDataEl.classList.add('hidden');

  var trackWidth = Math.max(600, (chartEl.clientWidth || 800) - RESOURCES_NAME_COL_WIDTH - 40);
  var columns = buildTimelineColumns(_state.start, _state.end, _state.granularity, 70);
  var totalTrackWidth = columns.reduce(function(sum, c){ return sum + c.width; }, 0);
  var scale = totalTrackWidth > 0 ? Math.max(trackWidth / totalTrackWidth, 0.3) : 1;
  var scaledColumns = columns.map(function(c){ return {start: c.start, end: c.end, label: c.label, width: c.width * scale}; });
  var scaledTrackWidth = scaledColumns.reduce(function(sum, c){ return sum + c.width; }, 0);
  var width = RESOURCES_NAME_COL_WIDTH + scaledTrackWidth + 20;

  var y = RESOURCES_MARGIN_TOP;
  var rowBounds = rows.map(function(row){
    var start = y;
    y += row.laneCount * RESOURCES_LANE_HEIGHT + RESOURCES_ROW_PADDING;
    return {start: start, end: y};
  });
  var height = y + 10;

  var defsHTML = noDatesPatternDefsSVG();

  var headerHTML = '';
  var x = RESOURCES_NAME_COL_WIDTH;
  scaledColumns.forEach(function(c){
    headerHTML += '<text x="' + (x + c.width / 2) + '" y="' + (RESOURCES_MARGIN_TOP - 12) + '" font-size="10" font-weight="600" text-anchor="middle" fill="var(--kf-text-secondary)">' + escapeHTML(c.label) + '</text>' +
      '<line x1="' + x + '" y1="' + (RESOURCES_MARGIN_TOP - 4) + '" x2="' + x + '" y2="' + height + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';
    x += c.width;
  });
  headerHTML += '<line x1="' + x + '" y1="' + (RESOURCES_MARGIN_TOP - 4) + '" x2="' + x + '" y2="' + height + '" stroke="var(--kf-border)" stroke-width="1" stroke-dasharray="2,3"/>';

  var bandsHTML = rows.map(function(row, i){
    var b = rowBounds[i];
    return '<rect x="0" y="' + b.start + '" width="' + width + '" height="' + (b.end - b.start) + '" fill="' + (i % 2 === 0 ? 'var(--kf-column-bg)' : 'transparent') + '" opacity="0.5"></rect>';
  }).join('');

  var rowsHTML = rows.map(function(row, i){
    var b = rowBounds[i];
    var labelX = row.hasFlag ? 24 : 8;
    var flagHTML = row.hasFlag
      ? '<g class="kf-resources-row-flag" transform="translate(4,' + (b.start + 4) + ')"><title>Concurrent allocation exceeds 100% in this date range</title>' + iconSvg('warning', 14) + '</g>'
      : '';
    var labelHTML = '<text x="' + labelX + '" y="' + (b.start + 16) + '" font-size="13" font-weight="600" fill="var(--kf-text)">' + escapeHTML(row.label) + '</text>';

    var barsHTML = row.bars.map(function(bar){
      // A project's own dates can run well before/after the currently-selected reporting period
      // (the window is now an independent, user-chosen range — see this file's header comment) —
      // tlDateToPixel extrapolates rather than clipping, so the RAW start/end can land off-screen
      // (negative x, or past the track's right edge). The <rect> itself is drawn at the raw extent
      // (the SVG's own viewBox clips it visually, same as Portfolio Planner's bars), but the label
      // must be anchored to the VISIBLE, on-screen portion only — anchoring it to the raw start
      // put it off-screen (and so invisible) whenever a bar's start fell before the window, which is
      // what made the label seem to randomly disappear depending on which date bracket was selected.
      var trackLeft = RESOURCES_NAME_COL_WIDTH, trackRight = RESOURCES_NAME_COL_WIDTH + scaledTrackWidth;
      var rawStartX = RESOURCES_NAME_COL_WIDTH + tlDateToPixel(new Date(bar.a.projectStartDate), scaledColumns);
      var rawEndX = RESOURCES_NAME_COL_WIDTH + tlDateToPixel(new Date(bar.a.projectEndDate), scaledColumns);
      var barStartX = rawStartX, barWidth = Math.max(4, rawEndX - rawStartX);
      var visibleStartX = Math.max(trackLeft, rawStartX), visibleEndX = Math.min(trackRight, rawEndX);
      var visibleWidth = visibleEndX - visibleStartX;
      var barY = b.start + RESOURCES_ROW_PADDING / 2 + bar.lane * RESOURCES_LANE_HEIGHT + 2;
      var barHeight = RESOURCES_LANE_HEIGHT - 4;
      var opacity = Math.max(0.25, bar.a.allocatedFraction / 100);
      var isUnfilled = bar.a.isPlaceholder && !bar.a.userId;
      var fillAttr = isUnfilled ? 'url(#portfolioNoDatesPattern)' : bar.color;
      var barLabel = _state.groupBy === 'person' ? bar.a.projectKey : (bar.a.displayName || ('Unfilled — ' + bar.a.role));
      var titleText = (bar.a.displayName || ('Unfilled — ' + (bar.a.role || 'role'))) + ' — ' + bar.a.projectName + ' (' + bar.a.allocatedFraction + '%)';
      return '<rect class="kf-resources-bar" data-project-id="' + bar.a.projectId + '" data-user-id="' + (bar.a.userId || '') + '" data-role="' + escapeHTML(bar.a.role || '') + '" ' +
        'x="' + barStartX + '" y="' + barY + '" width="' + barWidth + '" height="' + barHeight + '" rx="4" ' +
        'fill="' + fillAttr + '" fill-opacity="' + opacity + '" stroke="' + bar.color + '" stroke-width="1">' +
        '<title>' + escapeHTML(titleText) + '</title></rect>' +
        (visibleWidth > 34 ? '<text x="' + (visibleStartX + 6) + '" y="' + (barY + barHeight / 2 + 4) + '" font-size="10" fill="var(--kf-text)" pointer-events="none">' + escapeHTML(barLabel) + '</text>' : '');
    }).join('');

    return labelHTML + flagHTML + barsHTML;
  }).join('');

  chartEl.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" class="kf-resources-svg">' + defsHTML + bandsHTML + headerHTML + rowsHTML + '</svg>';
  wireResourcesBarHover();
}

function renderResourcesUndatedNote(){
  var el = document.getElementById('resourcesUndatedNote');
  var undated = _assignments.filter(function(a){ return !a.projectStartDate || !a.projectEndDate; });
  if(undated.length === 0){ el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  var items = undated.map(function(a){
    var who = a.displayName || ('Unfilled — ' + (a.role || 'role'));
    return '<li>' + escapeHTML(who) + ' — ' + escapeHTML(a.projectName) + ' (' + a.allocatedFraction + '%)</li>';
  }).join('');
  el.innerHTML = '<div class="kf-resources-undated-title">Undated allocations (not shown on the chart above — the owning project has no start/end date set)</div>' +
    '<ul class="kf-resources-undated-list">' + items + '</ul>';
}

/* Hover flyout — same delegated-listener + close-grace-period pattern as views/board.js's
   openTaskDepPopover (see root CLAUDE.md's "Hover-anchored popover pattern"), wired once against the
   stable #resourcesChart container (only its innerHTML is replaced on re-render). */
var resourcesChartHoverWired = false;
var resourcesPopoverCloseTimer = null;
function scheduleCloseResourcesPopover(){
  clearTimeout(resourcesPopoverCloseTimer);
  resourcesPopoverCloseTimer = setTimeout(closeResourcesPopover, 300);
}
function wireResourcesBarHover(){
  if(resourcesChartHoverWired) return;
  resourcesChartHoverWired = true;
  var chartEl = document.getElementById('resourcesChart');
  chartEl.addEventListener('mouseover', function(e){
    var bar = e.target.closest('.kf-resources-bar');
    if(!bar) return;
    clearTimeout(resourcesPopoverCloseTimer);
    openResourcesPopover(bar);
  });
  chartEl.addEventListener('mouseout', function(e){
    if(e.target.closest('.kf-resources-bar')) scheduleCloseResourcesPopover();
  });
  var popover = document.getElementById('resourcesPopover');
  popover.addEventListener('mouseenter', function(){ clearTimeout(resourcesPopoverCloseTimer); });
  popover.addEventListener('mouseleave', closeResourcesPopover);
}

function openResourcesPopover(barEl){
  var projectId = barEl.getAttribute('data-project-id');
  var userId = barEl.getAttribute('data-user-id') || null;
  var role = barEl.getAttribute('data-role') || '';
  var a = _assignments.filter(function(x){
    return x.projectId === projectId && (x.userId || '') === (userId || '') && (x.role || '') === role;
  })[0];
  if(!a) return;

  document.getElementById('resourcesPopoverTitle').textContent = a.displayName || ('Unfilled — ' + (a.role || 'role'));
  document.getElementById('resourcesPopoverList').innerHTML =
    '<div class="kf-resources-popover-row"><strong>Project</strong> ' + escapeHTML(a.projectName) + ' (' + escapeHTML(a.projectKey) + ')</div>' +
    '<div class="kf-resources-popover-row"><strong>Role</strong> ' + escapeHTML(a.role || 'Unspecified') + '</div>' +
    '<div class="kf-resources-popover-row"><strong>Dates</strong> ' + formatDateStr(a.projectStartDate) + ' – ' + formatDateStr(a.projectEndDate) + '</div>' +
    '<div class="kf-resources-popover-row"><strong>Allocation</strong> ' + a.allocatedFraction + '%</div>';

  var popover = document.getElementById('resourcesPopover');
  popover.classList.remove('hidden');
  var rect = barEl.getBoundingClientRect();
  var popW = popover.offsetWidth || 240;
  var left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 12));
  popover.style.left = left + 'px';
  popover.style.top = (rect.bottom + 8) + 'px';
}
function closeResourcesPopover(){
  clearTimeout(resourcesPopoverCloseTimer);
  document.getElementById('resourcesPopover').classList.add('hidden');
}
