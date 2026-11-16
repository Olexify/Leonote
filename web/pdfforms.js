// AcroForm filling. pdf.js hands back every widget in one call
// (`getFieldObjects`), including which page it is on and its rectangle, so the
// fields can be typed into *where they are on the page* rather than in a list
// off to the side. What is typed stays in memory until the file is saved;
// pdfdoc.fillForm then writes only the fields that actually changed.

import { h } from "./util.js";
import { fieldModel, changedFields, coerceField } from "./pdfcore.js";

const CTOR = {
  text: "PDFTextField", checkbox: "PDFCheckBox", radiobutton: "PDFRadioGroup",
  combobox: "PDFDropdown", listbox: "PDFOptionList", button: "PDFButton", signature: "PDFSignature",
};

export function createForms(view, opts = {}) {
  let model = [];
  let widgets = new Map(); // page index -> [{ key, field, rect, exportValue }]
  let edits = {};
  let active = true;

  async function scan(doc) {
    // A page move rebuilds the document and rescans it, but the answers the
    // reader has already typed belong to field *names*, which page surgery
    // never changes - so they are carried across rather than thrown away.
    const typed = {};
    for (const f of model) if (f.key in edits) typed[f.name] = edits[f.key];
    model = []; widgets = new Map(); edits = {};
    let raw = null;
    try { raw = await doc.getFieldObjects(); } catch { raw = null; }
    if (!raw) return 0;
    // `getFieldObjects` returns the whole field tree, so a dotted name like
    // "customer.full_name" comes back as the branch node ("customer"), the
    // field node, and then the widget that is actually on a page. Only the
    // last of those has a `type`; taking the first entry instead is how a
    // checkbox ends up drawn as a text box and a filled value reads as empty.
    const flat = [];
    for (const [name, list] of raw) {
      const parts = (list || []).filter((p) => p && p.type);
      if (!parts.length) continue; // a branch of the field tree, not a field
      const first = parts[0];
      const mixed = mixedTick(parts);
      const items = first.items || [];
      flat.push({
        ctor: CTOR[first.type] || "PDFTextField",
        name,
        value: first.type === "checkbox" || first.type === "radiobutton" ? pickChecked(parts) : first.value,
        options: items.length ? items.map((it) => String(it.exportValue ?? it.displayValue)) : first.type === "radiobutton" ? parts.map((p) => String(p.exportValue ?? "")).filter(Boolean) : mixed ? parts.map((p) => String(exportOf(p) ?? "")).filter(Boolean) : null,
        readOnly: first.editable === false,
        multiline: !!first.multiline,
        maxLength: first.charLimit || null,
        parts,
      });
    }
    model = fieldModel(flat);
    for (const f of model) if (f.name in typed) edits[f.key] = typed[f.name];
    model.forEach((f, i) => {
      for (const p of flat[i].parts) {
        if (!Number.isInteger(p.page) || !p.rect || p.hidden) continue;
        if (!widgets.has(p.page)) widgets.set(p.page, []);
        const on = exportOf(p);
        widgets.get(p.page).push({ key: f.key, field: f, rect: p.rect, exportValue: on == null ? null : String(on) });
      }
    });
    return model.length;
  }

  const exportOf = (p) => p.exportValues ?? p.exportValue;
  const isTicked = (p) => !!p.value && p.value !== "Off";
  // Tick boxes that share a name but answer differently (a Yes/No pair): the field's value says which one, as in a radio group.
  const mixedTick = (parts) => parts[0].type === "checkbox" && new Set(parts.map(exportOf).filter((x) => x != null).map(String)).size > 1;

  /** A tick is on when one of its widgets holds anything but /Off. */
  const pickChecked = (parts) => {
    const on = parts.find(isTicked);
    // Every widget of a radio group carries the group's answer, so the value says which option it is, not the widget.
    if (mixedTick(parts)) { const box = parts.find((p) => String(p.value) === String(exportOf(p))); return box ? String(box.value) : ""; }
    if (parts[0].type === "checkbox") return !!on;
    return on ? String(on.value) : "";
  };

  const valueOf = (f) => (f.key in edits ? edits[f.key] : f.value);

  function paint(i) {
    const layer = view.formLayer ? view.formLayer(i) : null;
    const host = layer || (view.annotLayer(i) && view.annotLayer(i).parentElement && view.annotLayer(i).parentElement.querySelector(".pdfv-form"));
    if (!host) return;
    host.replaceChildren();
    host.hidden = !active;
    const list = widgets.get(i);
    const vp = view.viewportOf(i);
    if (!active || !list || !vp) return;
    for (const w of list) {
      const [ax, ay] = vp.convertToViewportPoint(w.rect[0], w.rect[1]);
      const [bx, by] = vp.convertToViewportPoint(w.rect[2], w.rect[3]);
      const box = { left: Math.min(ax, bx), top: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
      const el = control(w, box, vp.scale);
      if (el) host.append(el);
    }
  }

  function control(w, box, scale) {
    const f = w.field;
    const style = { left: box.left + "px", top: box.top + "px", width: Math.max(8, box.width) + "px", height: Math.max(8, box.height) + "px" };
    const v = valueOf(f);
    const set = (nv) => {
      edits[f.key] = coerceField(f.kind, nv, f.options);
      opts.onChange && opts.onChange();
    };
    if (f.kind === "check" || f.kind === "radio") {
      const on = f.options ? String(v) === String(w.exportValue) : v === true;
      const btn = h("button", {
        class: "pdff-tick" + (on ? " is-on" : ""), style, type: "button", disabled: f.readOnly,
        title: f.label,
        onclick: () => { set(f.options ? (on ? "" : w.exportValue) : !on); paintAll(); },
      });
      return btn;
    }
    if (f.kind === "choice") {
      const sel = h("select", { class: "pdff-in", style, disabled: f.readOnly, title: f.label, onchange: (e) => set(e.target.value) },
        h("option", { value: "", text: "" }),
        (f.options || []).map((o) => h("option", { value: o, text: o, selected: String(v) === o })));
      sel.style.fontSize = Math.max(9, Math.min(18, box.height * 0.62)) + "px";
      return sel;
    }
    if (f.kind === "list") {
      const sel = h("select", { class: "pdff-in", style, multiple: true, disabled: f.readOnly, title: f.label, onchange: (e) => set([...e.target.selectedOptions].map((o) => o.value)) },
        (f.options || []).map((o) => h("option", { value: o, text: o, selected: (v || []).includes(o) })));
      return sel;
    }
    const tag = f.multiline ? "textarea" : "input";
    const el = h(tag, {
      class: "pdff-in", style, value: v == null ? "" : String(v), readOnly: f.readOnly,
      maxLength: f.maxLength || null, title: f.label, spellcheck: "false",
      oninput: (e) => set(e.target.value),
      onkeydown: (e) => e.stopPropagation(),
    });
    el.style.fontSize = Math.max(9, Math.min(20, box.height * (f.multiline ? 0.28 : 0.62))) + "px";
    return el;
  }

  const paintAll = () => { for (const i of widgets.keys()) paint(i); };

  return {
    scan,
    paint,
    paintAll,
    get count() { return model.length; },
    get active() { return active; },
    setActive(on) { active = !!on; paintAll(); },
    changes: () => changedFields(model, edits),
    reset() { edits = {}; paintAll(); },
  };
}
