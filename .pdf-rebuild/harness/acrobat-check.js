// Relecture T1 - verification par Adobe Acrobat Pro (IAC, invisible). cscript //nologo acro.js <pdf>...
function esc(s) {
  var out = "";
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c == "\\") out += "\\\\";
    else if (c == '"') out += "'";
    else if (code < 32) out += " ";
    else out += c;
  }
  return out;
}
function j(v) {
  if (v === null || v === undefined) return "null";
  var t = typeof v;
  if (t == "number" || t == "boolean") return String(v);
  if (t == "string") return '"' + esc(v) + '"';
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(j(v[i])); return "[" + a.join(",") + "]"; }
  var o = []; for (var k in v) o.push('"' + k + '":' + j(v[k])); return "{" + o.join(",") + "}";
}
var args = WScript.Arguments;
var app = new ActiveXObject("AcroExch.App");
for (var i = 0; i < args.length; i++) {
  var f = args(i);
  var r = { file: f.substr(f.lastIndexOf("\\") + 1) };
  var pd = new ActiveXObject("AcroExch.PDDoc");
  try {
    r.open = pd.Open(f);
    if (r.open) {
      var jso = pd.GetJSObject();
      r.pages = jso.numPages;
      r.dirty = jso.dirty;
      try { r.title = String(jso.info.Title || ""); r.author = String(jso.info.Author || ""); r.producer = String(jso.info.Producer || ""); } catch (e) { r.infoErr = e.message; }
      try { r.sec = String(jso.securityHandler || ""); } catch (e) {}
      try {
        r.annots = [];
        for (var pg = 0; pg < jso.numPages; pg++) {
          var pp = pd.AcquirePage(pg);
          var na = pp.GetNumAnnots();
          for (var a = 0; a < na; a++) { var an = pp.GetAnnot(a); var st = an.GetSubtype(); if (st != "Link" && st != "Widget" && st != "Popup") r.annots.push("p" + (pg + 1) + ":" + st + ":" + String(an.GetContents() || "").substr(0, 25)); }
        }
      } catch (e) { r.annErr = e.message; }
      var n = jso.numFields; r.numFields = n; r.sigs = []; r.vals = [];
      for (var k = 0; k < n; k++) {
        var name = jso.getNthFieldName(k);
        var fld = jso.getField(name);
        if (fld.type == "signature") {
          var s = { name: name };
          try { s.validate = fld.signatureValidate(); } catch (e) { s.vErr = e.message; }
          try {
            var inf = fld.signatureInfo();
            for (var tries = 0; tries < 12 && inf.status == 1; tries++) { WScript.Sleep(500); try { fld.signatureValidate(); } catch (e2) {} inf = fld.signatureInfo(); }
            s.tries = tries;
            s.status = inf.status; s.statusText = String(inf.statusText || ""); s.docValidity = inf.docValidity; s.objValidity = inf.objValidity; s.revision = inf.revision;
          } catch (e) { s.iErr = e.message; }
          r.sigs.push(s);
        } else {
          try { var v = fld.value; if (v !== "" && v !== "Off" && v !== null) r.vals.push(name + "=" + String(v).substr(0, 30)); } catch (e) {}
        }
      }
      pd.Close();
    }
  } catch (e) { r.error = e.message; }
  WScript.Echo(j(r));
}
app.CloseAllDocs();
app.Exit();
