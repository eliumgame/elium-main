/** Untrusted CRDT JSON: validate at the boundary, before handing it to UI/export code. */
export type Obj = Record<string, unknown>;
export const record = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
export const str = (v: unknown): v is string => typeof v === "string";
export const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
export const bool = (v: unknown): v is boolean => typeof v === "boolean";
export const int = (v: unknown, max = 1_048_576): v is number => num(v) && Number.isInteger(v) && v >= 0 && v <= max;
export const dimension = (v: unknown, fallback: number, max: number) => int(v, max) && v > 0 ? v : fallback;
type Guard = (v: unknown) => boolean;
export const list = (guard: Guard, max = 10_000): Guard => (v) => Array.isArray(v) && v.length <= max && v.every(item => guard(item));
export const oneOf = (...values: unknown[]): Guard => (v) => values.includes(v);
export const fields = (required: Record<string, Guard>, optional: Record<string, Guard> = {}): Guard => (v) =>
  record(v) && Object.entries(required).every(([k, check]) => check(v[k])) &&
  Object.entries(optional).every(([k, check]) => v[k] === undefined || check(v[k]));
export const rect = { c0: (v: unknown) => int(v, 16_383), c1: (v: unknown) => int(v, 16_383), r0: int, r1: int };
export const cellRef = (v: unknown): v is string => str(v) && /^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(v);
const edge = fields({ style: oneOf("thin", "medium", "thick", "dashed", "dotted", "double") }, { color: str });
export const cellStyle = fields({}, {
  bold: bool, italic: bool, align: oneOf("left", "center", "right"), color: str, fill: str,
  fmt: oneOf("general", "number", "int", "currency", "percent", "date", "datetime", "custom"),
  customFmt: str, fontFamily: str, fontSize: num, border: fields({}, { top: edge, right: edge, bottom: edge, left: edge }),
});
const chartOptions = fields({}, {
  grouping: str, horizontal: bool, legend: str, dataLabels: bool, xTitle: str, yTitle: str, y2Title: str,
  yMin: num, yMax: num, yFormat: str, trendline: fields({ type: oneOf("linear", "poly", "avg") }, { order: num, period: num, series: int }),
  seriesTypes: list(oneOf("bar", "line")), secondary: list(int), smooth: bool, colors: list(str),
});
export const sheetExtras: Record<string, Guard> = {
  merges: fields(rect),
  condFormats: fields({ ...rect, id: str, op: oneOf("gt", "lt", "ge", "le", "eq", "ne", "between", "contains", "empty", "notEmpty", "colorScale", "top10", "duplicate") },
    { v1: str, v2: str, fill: str, color: str, bold: bool, scale: fields({ min: str, max: str }, { mid: str }), rank: num, bottom: bool, percent: bool }),
  validations: fields({ ...rect, id: str, type: oneOf("list", "number", "textLength", "date") },
    { op: str, v1: str, v2: str, list: list(str), listRef: str, allowBlank: bool }),
  charts: fields({ ...rect, id: str, type: oneOf("bar", "line", "pie", "area", "scatter", "combo") }, { title: str, opts: chartOptions }),
  tables: fields({ ...rect, id: str, name: str }, { banded: bool, totals: bool, color: str }),
  print: fields({}, { orientation: str, paper: str, scale: num, fitWidth: bool, gridlines: bool, headings: bool, order: str,
    margins: fields({ top: num, right: num, bottom: num, left: num }), area: fields(rect),
    repeatRows: fields({ r0: int, r1: int }), repeatCols: fields({ c0: int, c1: int }), rowBreaks: list(int), colBreaks: list(int), header: str, footer: str }),
  pivot: fields({ id: str, source: fields({ ...rect, sheet: str }), rowField: str, colField: (v) => v === null || str(v), valueField: str, agg: oneOf("sum", "count", "avg", "min", "max") },
    { rowDateGroup: str, colDateGroup: str, sort: str, calcFields: list(fields({ name: str, formula: str })) }),
};
const geometry = { x: num, y: num, w: num, h: num };
export const shape = fields({ id: str, kind: str, ...geometry, fill: str, stroke: str, strokeWidth: num }, { text: str });
export const element = (v: unknown): boolean => {
  if (!fields({ id: str, type: oneOf("text", "shape", "image", "table", "chart", "media", "diagram"), ...geometry }, {
    rotation: num, opacity: num, locked: bool, groupId: str, morphKey: str, ph: str, html: str, fontSize: num,
    fontFamily: str, color: str, align: str, valign: str, shape: str, fill: str, stroke: str, strokeWidth: num, radius: num, text: str, src: str,
  })(v) || !record(v)) return false;
  if (v.type === "table") return fields({ rows: (n) => dimension(n, 0, 1000) > 0, cols: (n) => dimension(n, 0, 1000) > 0, cells: list(list(str, 1000), 1000) },
    { merges: list(fields({ r: int, c: int, rs: int, cs: int })), style: str, headerRow: bool, firstCol: bool })(v.table);
  if (v.type === "chart") return fields({ kind: oneOf("bar", "line", "pie"), labels: list(str), values: list(num) }, { title: str })(v.chart);
  if (v.type === "media") return fields({ kind: oneOf("audio", "video"), src: str, mime: str }, { name: str, trimStart: num, trimEnd: num, autoplay: bool, loop: bool })(v.media);
  if (v.type === "diagram") return fields({ kind: oneOf("process", "cycle", "hierarchy", "list"), outline: str }, { colors: list(str) })(v.diagram);
  return true;
};
export const section = fields({ id: str, name: str, startSlideId: str }, { collapsed: bool });
export const master = fields({ name: str, fontHeading: str, fontBody: str, colorTitle: str, colorBody: str, colorAccent: str, background: str, footerText: str,
  layouts: list(fields({ id: str, name: str, placeholders: list(fields({ id: str, kind: str, ...geometry, fontSize: num, align: str, valign: str }, { bold: bool })) }, { background: str })) }, { showSlideNumber: bool });
