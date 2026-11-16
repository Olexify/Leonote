// The real pdf.js and pdf-lib: a big pdf.js update once turned the form fields' object into a Map and every form went silent.
import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createForms } from "../pdfforms.js";
import { fillForm } from "../pdfdoc.js";

// Node 20 has not got this one; WebView2 has
Promise.withResolvers ??= () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("a PDF's form fields are found through pdf.js itself", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([600, 800]);
  const tf = d.getForm().createTextField("name");
  tf.setText("Form value");
  tf.addToPage(page, { x: 50, y: 600, width: 300, height: 30 });
  const doc = await getDocument({ data: await d.save(), isEvalSupported: false }).promise;
  const forms = createForms({}, {});
  assert.equal(await forms.scan(doc), 1);
  assert.equal(forms.count, 1);
  await doc.loadingTask.destroy();
});

// Just enough of a DOM for the form's controls: each one's class, disabled and click are what matter here.
const painted = async (bytes) => {
  globalThis.document ??= { createElement: () => ({ style: {}, disabled: false, classList: { add() {} }, setAttribute() {}, append() {}, addEventListener(t, fn) { this["on" + t] = fn; } }) };
  const doc = await getDocument({ data: bytes.slice(), isEvalSupported: false }).promise; // pdf.js takes the bytes it is given
  const shown = [];
  const host = { replaceChildren() { shown.length = 0; }, append: (el) => shown.push(el) };
  const forms = createForms({ formLayer: () => host, viewportOf: () => ({ scale: 1, convertToViewportPoint: (x, y) => [x, y] }) }, {});
  await forms.scan(doc);
  forms.paint(0);
  return { doc, forms, shown };
};
const isOn = (el) => /is-on/.test(el.class ?? el.className ?? "");

test("a tick box with its own export value ticks, shows ticked and is saved", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([600, 800]);
  const cb = d.getForm().createCheckBox("agree");
  cb.addToPage(page, { x: 50, y: 600, width: 20, height: 20 });
  cb.check();
  // the same length, so the file's offsets stay right
  const raw = Buffer.from(await d.save({ useObjectStreams: false })).toString("latin1").replaceAll("/Yes", "/One");
  const { doc, forms, shown } = await painted(new Uint8Array(Buffer.from(raw, "latin1")));
  assert.equal(isOn(shown[0]), true, "already ticked in the file");
  shown[0].onclick();
  assert.equal(isOn(shown[0]), false);
  assert.deepEqual(forms.changes(), [{ name: "agree", kind: "check", value: false }]);
  await doc.loadingTask.destroy();
});

test("a filled radio group shows its own answer, and locked fields stay locked", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([600, 800]);
  const r = d.getForm().createRadioGroup("pick");
  for (const [i, o] of ["A", "B", "C"].entries()) r.addOptionToPage(o, page, { x: 50 + i * 40, y: 600, width: 20, height: 20 });
  r.select("C");
  const cb = d.getForm().createCheckBox("locked");
  cb.addToPage(page, { x: 50, y: 500, width: 20, height: 20 });
  cb.enableReadOnly();
  const { doc, forms, shown } = await painted(await d.save());
  assert.deepEqual(shown.slice(0, 3).map(isOn), [false, false, true]);
  assert.equal(shown[3].disabled, true);
  shown[0].onclick();
  assert.deepEqual(forms.changes(), [{ name: "pick", kind: "radio", value: "A" }]);
  await doc.loadingTask.destroy();
});

test("a Yes/No pair of tick boxes shows the file's answer and saves the box that was clicked", async () => {
  const d = await PDFDocument.create();
  const page = d.addPage([600, 800]);
  const cb = d.getForm().createCheckBox("pair");
  cb.addToPage(page, { x: 50, y: 600, width: 20, height: 20 });
  cb.addToPage(page, { x: 90, y: 600, width: 20, height: 20 });
  const no = cb.acroField.getWidgets()[1];
  const n = no.getNormalAppearance();
  n.set(PDFName.of("No"), n.get(PDFName.of("Yes")));
  n.delete(PDFName.of("Yes"));
  cb.acroField.dict.set(PDFName.of("V"), PDFName.of("No"));
  no.setAppearanceState(PDFName.of("No"));
  const bytes = await d.save({ updateFieldAppearances: false });
  const { doc, forms, shown } = await painted(bytes);
  assert.deepEqual(shown.map(isOn), [false, true]);
  assert.deepEqual(forms.changes(), []);
  const answer = async (bytes) => {
    const form = (await PDFDocument.load(bytes)).getForm().getCheckBox("pair").acroField;
    return [form.dict.get(PDFName.of("V")).decodeText(), ...form.getWidgets().map((w) => w.getAppearanceState().decodeText())];
  };
  const change = { name: "pair", kind: "check" };

  shown[1].onclick(); // No taken back: nothing ticked
  assert.deepEqual(shown.map(isOn), [false, false]);
  assert.deepEqual(forms.changes(), [{ ...change, value: "" }]);
  assert.deepEqual(await answer((await fillForm(bytes, forms.changes())).bytes), ["Off", "Off", "Off"]);

  shown[0].onclick(); // Yes
  assert.deepEqual(shown.map(isOn), [true, false]);
  assert.deepEqual(forms.changes(), [{ ...change, value: "Yes" }]);
  assert.deepEqual(await answer((await fillForm(bytes, forms.changes())).bytes), ["Yes", "Yes", "Off"]);
  await doc.loadingTask.destroy();

  // the same click saved from an empty pair: the box after the first is the one that ends up ticked, in pdf.js too
  const emptied = (await fillForm(bytes, [{ ...change, value: "" }])).bytes;
  const again = await painted(emptied);
  assert.deepEqual(again.shown.map(isOn), [false, false]);
  again.shown[1].onclick();
  assert.deepEqual(again.forms.changes(), [{ ...change, value: "No" }]);
  const saved = await fillForm(emptied, again.forms.changes());
  assert.deepEqual(saved.missed, []);
  assert.deepEqual(await answer(saved.bytes), ["No", "Off", "No"]);
  await again.doc.loadingTask.destroy();
  const reread = await painted(saved.bytes);
  assert.deepEqual(reread.shown.map(isOn), [false, true]);
  await reread.doc.loadingTask.destroy();
});
