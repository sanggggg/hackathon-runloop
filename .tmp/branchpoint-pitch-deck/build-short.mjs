import fs from "node:fs/promises";
import {
  FileBlob,
  PresentationFile,
} from "file:///Users/sangmin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const STARTER = "/Users/sangmin/Desktop/hackathon-runloop/.tmp/branchpoint-pitch-deck/template-short-inspect/template-starter.pptx";
const OUT = "/Users/sangmin/Desktop/hackathon-runloop/Branchpoint-Hackathon-Pitch.pptx";
const RENDER_DIR = "/Users/sangmin/Desktop/hackathon-runloop/.tmp/branchpoint-pitch-deck/short-output";
const APP_SCREENSHOT = "/Users/sangmin/Desktop/Screenshot 2026-08-29 at 5.39.18 PM.png";
const APP_SCREENSHOT_BYTES = await fs.readFile(APP_SCREENSHOT);

const C = {
  ink: "#101315",
  muted: "#5F676D",
  faint: "#959DA3",
  panel: "#F1F3F4",
  rule: "#C8CDD0",
  white: "#FFFFFF",
  teal: "#0A8F79",
  tealDark: "#076B5C",
  tealTint: "#E5F5F1",
  blue: "#3D8DFF",
  red: "#D94747",
};

const presentation = await PresentationFile.importPptx(await FileBlob.load(STARTER));

function textOf(shape) {
  return shape?.text?.toString?.() ?? "";
}

function findText(slide, text) {
  const shape = slide.shapes.items.find((item) => textOf(item) === text);
  if (!shape) throw new Error(`Missing text shape: ${JSON.stringify(text)}`);
  return shape;
}

function findTexts(slide, text) {
  return slide.shapes.items.filter((item) => textOf(item) === text);
}

function rewrite(slide, oldText, newText, style = {}, position) {
  const shape = findText(slide, oldText);
  shape.text.set(newText);
  if (Object.keys(style).length) {
    shape.text.style = {
      typeface: "Helvetica Neue",
      autoFit: "none",
      ...style,
    };
  }
  if (position) shape.position.set(position);
  return shape;
}

function deleteTexts(slide, texts) {
  const targets = new Set(texts);
  for (const shape of [...slide.shapes.items]) {
    if (targets.has(textOf(shape))) shape.delete();
  }
}

function addText(slide, text, x, y, w, h, size = 24, options = {}) {
  const box = slide.shapes.add({
    geometry: "textbox",
    name: options.name,
    position: { left: x, top: y, width: w, height: h },
    fill: options.fill ?? "none",
    line: options.line ?? { style: "solid", fill: "none", width: 0 },
    borderRadius: options.borderRadius,
  });
  box.text = text;
  box.text.style = {
    fontSize: size,
    bold: options.bold ?? false,
    color: options.color ?? C.ink,
    typeface: options.typeface ?? "Helvetica Neue",
    alignment: options.align ?? "left",
    verticalAlignment: options.valign ?? "top",
    autoFit: "none",
  };
  return box;
}

function addRect(slide, x, y, w, h, fill, options = {}) {
  return slide.shapes.add({
    geometry: options.geometry ?? "rect",
    name: options.name,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: options.line ?? {
      style: "solid",
      fill: options.stroke ?? "none",
      width: options.strokeWidth ?? 0,
    },
    ...(["rect", "textbox", "roundRect"].includes(options.geometry ?? "rect")
      ? { borderRadius: options.radius ?? 0 }
      : {}),
    shadow: options.shadow,
  });
}

function addLine(slide, x, y, w, h, color = C.rule, width = 2) {
  return slide.shapes.add({
    geometry: "line",
    position: { left: x, top: y, width: w, height: h },
    fill: "none",
    line: { style: "solid", fill: color, width },
  });
}

function setNotes(slide, lines, sources = []) {
  slide.speakerNotes.textFrame.setText([
    ...lines,
    "",
    "[Sources]",
    ...sources.map((source) => `- ${source}`),
    "[/Sources]",
  ].join("\n"));
}

// 1 — minimal cover with the user's real app screenshot.
{
  const slide = presentation.slides.items[0];
  rewrite(slide, "Prepare once. Fork every scenario.\nRe-run the whole tree on every commit.", "Run setup once. Fork every scenario\nfrom the exact same state.", {
    fontSize: 25,
    color: C.muted,
  }, { left: 48, top: 356, width: 530, height: 92 });

  for (const image of [...slide.images.items]) image.delete();
  for (const shape of [...slide.shapes.items]) {
    if ((shape.pixelRect?.x ?? 0) >= 630) shape.delete();
  }

  addRect(slide, 626, 100, 600, 512, C.white, {
    name: "app-screenshot-backing",
    stroke: C.rule,
    strokeWidth: 1,
    radius: 14,
    shadow: "shadow-sm",
  });
  slide.images.add({
    blob: APP_SCREENSHOT_BYTES,
    contentType: "image/png",
    alt: "Branchpoint Run screen showing the nested visual QA execution tree and wall-clock comparison",
    fit: "cover",
    geometry: "roundRect",
    borderRadius: 10,
    position: { left: 632, top: 106, width: 588, height: 500 },
  });
  setNotes(slide, [
    "Opening claim: expensive browser setup should happen once; every scenario should inherit the same state.",
    "The screenshot is the actual Branchpoint Run screen supplied by the presenter, including the nested result tree and measured wall-clock comparison.",
  ], [
    "/Users/sangmin/Desktop/hackathon-runloop/README.md",
    APP_SCREENSHOT,
  ]);
}

// 2 — exact three-way benchmark numbers, immediately after the cover.
{
  const slide = presentation.slides.items[1];
  rewrite(slide, "The sweet spot: fan-out speed without fan-out waste.", "Fastest wall time. Lowest LLM cost.", {
    fontSize: 42,
    bold: true,
    color: C.white,
  });
  rewrite(slide, "3 controlled runs · Trials 1–3 · cold cache before every method · same model, task, tools, and fixture", "3 controlled runs · Trials 1–3 · cold cache before every method", {
    fontSize: 19,
    color: "#B7C0C5",
  });
  rewrite(slide, "shared prefix · 78.0% cache read · 13.7 req", "shared prefix · source box + N−1 forks", {
    fontSize: 16,
    color: "#AAB4B9",
  });
  rewrite(slide, "full path × 3 · 77.4% cache read · 25.3 req", "one box · three complete trajectories", {
    fontSize: 16,
    color: "#AAB4B9",
  });
  rewrite(slide, "full path × 3 · 74.3% cache read · 22.3 req", "three boxes · three complete trajectories", {
    fontSize: 16,
    color: "#AAB4B9",
  });

  deleteTexts(slide, [
    "180–240", "57.1–84.7", "$0.115–0.196", "141.8–226.1", "$0.160–0.260",
    "50.9–111.8", "$0.152–0.243",
    "Mean (min–max) · n=3, Trials 1–3 · 9/9 branches per method passed 8/8 · Runloop /usage",
  ]);

  for (const metric of ["200s", "220s", "66.8s", "171.6s", "76.1s", "$0.150", "$0.198", "$0.188"]) {
    for (const shape of findTexts(slide, metric)) {
      const frame = shape.pixelRect;
      shape.position.set({ left: frame.x, top: frame.y + 12, width: frame.width, height: 42 });
      shape.text.style = {
        fontSize: 33,
        bold: true,
        color: textOf(shape) === "200s" && frame.y < 300 ? "#78E4D0" :
          ["66.8s", "$0.150", "Branchpoint"].includes(textOf(shape)) ? "#78E4D0" : C.white,
        typeface: "Helvetica Neue",
        autoFit: "none",
      };
    }
  }
  for (const header of ["METHOD", "ACTIVE SANDBOX", "WALL TIME", "LLM COST"]) {
    findText(slide, header).text.style = {
      fontSize: 14,
      bold: true,
      color: "#8F9AA0",
      typeface: "Helvetica Neue",
      autoFit: "none",
    };
  }
  rewrite(slide, "vs sequential  ·  wall −61.1%  ·  LLM −24.2%  ·  sandbox equal", "vs sequential · wall −61.1% · LLM −24.2% · sandbox equal", {
    fontSize: 16,
    bold: true,
    color: "#78E4D0",
  });
  rewrite(slide, "vs fan-out  ·  wall −12.2%  ·  sandbox −9.1%  ·  LLM −20.3%", "vs fan-out · wall −12.2% · sandbox −9.1% · LLM −20.3%", {
    fontSize: 16,
    bold: true,
    color: "#78E4D0",
  });
  rewrite(slide, "07", "02", { fontSize: 13, color: "#8F9AA0", alignment: "right" });
}

// 3 — a runtime tree that forks repeatedly as deeper choices are discovered.
{
  const slide = presentation.slides.items[2];
  rewrite(slide, "The test is short. Getting back to the right state is not.", "The tree keeps branching as the agent discovers it.", {
    fontSize: 40,
    bold: true,
    color: C.ink,
  });
  rewrite(slide, "Every scenario repeats the same expensive prelude.", "Fork is a runtime event—not a one-shot fan-out.", {
    fontSize: 20,
    color: C.muted,
  });
  rewrite(slide, "02", "03", { fontSize: 13, color: C.faint, alignment: "right" });

  for (const shape of [...slide.shapes.items]) {
    const frame = shape.pixelRect;
    if (frame && frame.y >= 200 && frame.y < 650) shape.delete();
  }

  // Connectors are added before nodes. Root forks once; Team and Solo fork again later.
  addLine(slide, 228, 379, 31, 0, C.teal, 3);
  addLine(slide, 329, 379, 26, 0, C.teal, 3);
  addLine(slide, 355, 249, 0, 260, C.teal, 3);
  addLine(slide, 355, 249, 35, 0, C.teal, 3);
  addLine(slide, 355, 379, 35, 0, C.teal, 3);
  addLine(slide, 355, 509, 35, 0, C.teal, 3);

  addLine(slide, 580, 249, 43, 0, C.teal, 2);
  addLine(slide, 689, 249, 31, 0, C.teal, 2);
  addLine(slide, 720, 210, 0, 65, C.teal, 2);
  addLine(slide, 720, 210, 35, 0, C.teal, 2);
  addLine(slide, 720, 275, 35, 0, C.teal, 2);
  addLine(slide, 935, 210, 20, 0, C.teal, 2);

  addLine(slide, 580, 379, 43, 0, C.teal, 2);
  addLine(slide, 689, 379, 31, 0, C.teal, 2);
  addLine(slide, 720, 340, 0, 130, C.teal, 2);
  addLine(slide, 720, 340, 35, 0, C.teal, 2);
  addLine(slide, 720, 405, 35, 0, C.teal, 2);
  addLine(slide, 720, 470, 35, 0, C.teal, 2);

  addLine(slide, 1110, 208, 0, 366, C.rule, 1);

  addRect(slide, 48, 338, 180, 82, C.ink, { radius: 11 });
  addText(slide, "SIGNED-IN\nFIXTURE", 66, 356, 144, 48, 19, { bold: true, color: C.white, align: "center", valign: "middle" });

  const forkEvents = [
    { x: 250, y: 335, n: "#1" },
    { x: 614, y: 205, n: "#2" },
    { x: 614, y: 335, n: "#3" },
  ];
  for (const event of forkEvents) {
    addRect(slide, event.x, event.y, 88, 88, "none", { geometry: "ellipse", stroke: "#8FD8CA", strokeWidth: 2 });
    addRect(slide, event.x + 9, event.y + 9, 70, 70, C.ink, { geometry: "ellipse" });
    addText(slide, `FORK\n${event.n}`, event.x + 9, event.y + 20, 70, 42, 13, {
      bold: true,
      color: "#78E4D0",
      align: "center",
      valign: "middle",
    });
  }

  const levelOne = [
    { y: 220, label: "Team plan", fill: C.tealTint, stroke: C.teal, color: C.tealDark },
    { y: 350, label: "Solo plan", fill: C.white, stroke: C.rule, color: C.ink },
    { y: 480, label: "Decide later · terminal", fill: C.white, stroke: C.rule, color: C.ink },
  ];
  for (const node of levelOne) {
    addRect(slide, 390, node.y, 190, 58, node.fill, { stroke: node.stroke, strokeWidth: 1, radius: 9 });
    addText(slide, node.label, 408, node.y + 17, 154, 26, 18, { bold: true, color: node.color });
  }

  addRect(slide, 755, 185, 180, 50, C.tealTint, { stroke: C.teal, strokeWidth: 1, radius: 8 });
  addText(slide, "Invite teammates", 770, 199, 150, 24, 16, { bold: true, color: C.tealDark });
  addRect(slide, 955, 185, 150, 50, C.tealTint, { stroke: C.teal, strokeWidth: 1, radius: 8 });
  addText(slide, "Send invitations", 968, 199, 124, 24, 15, { bold: true, color: C.tealDark });
  addRect(slide, 755, 250, 350, 50, C.white, { stroke: C.rule, strokeWidth: 1, radius: 8 });
  addText(slide, "Skip invites", 773, 264, 314, 24, 17, { bold: true, color: C.ink });

  const leaves = [
    { y: 315, label: "Starter template", fill: C.tealTint, stroke: C.teal, color: C.tealDark },
    { y: 380, label: "Blank workspace", fill: C.white, stroke: C.rule, color: C.ink },
    { y: 445, label: "Import from CSV", fill: C.white, stroke: C.rule, color: C.ink },
  ];
  for (const leaf of leaves) {
    addRect(slide, 755, leaf.y, 350, 50, leaf.fill, { stroke: leaf.stroke, strokeWidth: 1, radius: 8 });
    addText(slide, leaf.label, 773, leaf.y + 14, 314, 24, 17, { bold: true, color: leaf.color });
  }

  addText(slide, "3", 1132, 238, 70, 48, 38, { bold: true, color: C.tealDark });
  addText(slide, "branchpoints", 1132, 284, 110, 24, 16, { color: C.muted });
  addText(slide, "6", 1132, 360, 70, 48, 38, { bold: true, color: C.tealDark });
  addText(slide, "terminal paths", 1132, 406, 110, 42, 16, { color: C.muted });
  addText(slide, "N−1", 1132, 482, 90, 48, 32, { bold: true, color: C.tealDark });
  addText(slide, "new boxes\nat each fork", 1132, 528, 105, 52, 16, { color: C.muted });

  addRect(slide, 48, 602, 18, 18, C.tealTint, { stroke: C.teal, strokeWidth: 1, radius: 4 });
  addText(slide, "source box continues", 76, 601, 210, 24, 16, { color: C.muted });
  addRect(slide, 318, 602, 18, 18, C.white, { stroke: C.rule, strokeWidth: 1, radius: 4 });
  addText(slide, "new devbox from snapshot", 346, 601, 260, 24, 16, { color: C.muted });

  setNotes(slide, [
    "The run shown in the supplied Branchpoint screenshot has three branchpoints: the signed-in root, Team plan, and Solo plan. Those branchpoints resolve into six terminal paths, including the deeper Invite teammates to Send invitations chain.",
    "At every branchpoint, the current devbox continues as one child and only N−1 sibling devboxes are created from the snapshot.",
    "Nested snapshots also preserve nested LLM transcript prefixes for prompt-cache reuse.",
  ], [
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/lib/fixtures.ts",
    "/Users/sangmin/Desktop/hackathon-runloop/experiments/three-way-benchmark.py",
  ]);
}

// 4 — preserve the recursive tree and make the optimization rules legible.
{
  const slide = presentation.slides.items[3];
  rewrite(slide, "Straight steps stay on one devbox. Nested branches snapshot again.", "Reuse the current box until a node actually fans out.", {
    fontSize: 20,
    color: C.muted,
  });

  const snapBackgrounds = slide.shapes.items
    .filter((shape) => {
      const frame = shape.pixelRect;
      return !textOf(shape) && frame && frame.width >= 55 && frame.width <= 57 && frame.height === 34;
    })
    .map((shape) => ({ shape, frame: { ...shape.pixelRect } }));
  for (const { shape, frame } of snapBackgrounds) {
    shape.position.set({ left: frame.x - 7, top: frame.y, width: 70, height: frame.height });
  }
  for (const snap of findTexts(slide, "SNAP")) {
    const frame = snap.pixelRect;
    const nearest = snapBackgrounds
      .map((item) => ({ ...item, distance: Math.abs(item.frame.x - frame.x) + Math.abs(item.frame.y - frame.y) }))
      .sort((a, b) => a.distance - b.distance)[0];
    snap.position.set({ left: nearest.frame.x - 7, top: nearest.frame.y, width: 70, height: 34 });
    snap.text.style = {
      fontSize: 12,
      bold: true,
      color: "#78E4D0",
      typeface: "Helvetica Neue",
      alignment: "center",
      verticalAlignment: "middle",
      autoFit: "none",
    };
  }
  rewrite(slide, "snapshot", "2+ children", {
    fontSize: 17,
    bold: true,
    color: C.ink,
  }, { left: 1070, top: 202, width: 150, height: 24 });
  rewrite(slide, "only where a node\nhas 2+ children", "snapshot here", {
    fontSize: 17,
    color: C.tealDark,
  }, { left: 1070, top: 236, width: 150, height: 28 });
  rewrite(slide, "same box", "1 child", {
    fontSize: 17,
    bold: true,
    color: C.ink,
  }, { left: 1070, top: 332, width: 150, height: 24 });
  rewrite(slide, "for a straight\nsingle-child run", "stay on same box", {
    fontSize: 17,
    color: C.tealDark,
  }, { left: 1070, top: 366, width: 160, height: 28 });
  rewrite(slide, "Fixture tree · 3 levels", "shared LLM prefix\n→ cache reuse", {
    fontSize: 16,
    bold: true,
    color: C.tealDark,
  }, { left: 1070, top: 512, width: 160, height: 54 });
  setNotes(slide, [
    "The executor is recursive: snapshot only when the current node has two or more children; a single-child chain stays on the same devbox.",
    "Nested forks create nested cacheable transcript prefixes, so the infrastructure and LLM optimization follow the same execution tree.",
  ], [
    "/Users/sangmin/Desktop/hackathon-runloop/docs/build-spec.html — Engine: how a run walks the tree",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/lib/fixtures.ts",
  ]);
}

// 5 — result tree plus the closing line, merged into one slide.
{
  const slide = presentation.slides.items[4];
  rewrite(slide, "A commit becomes a visual QA tree.", "Every commit returns a visual QA tree.", {
    fontSize: 40,
    bold: true,
    color: C.ink,
  });
  rewrite(slide, "Green: journey intact · Red: app regression · Blue: newly discovered path", "Green = intact · Red = regression · Blue = new path", {
    fontSize: 19,
    color: C.muted,
  });
  rewrite(slide, "06", "05", { fontSize: 13, color: C.faint, alignment: "right" });

  for (const image of [...slide.images.items]) image.delete();
  for (const shape of [...slide.shapes.items]) {
    const frame = shape.pixelRect;
    if (frame && frame.x >= 800 && frame.y >= 180) shape.delete();
  }
  for (const shape of [...slide.shapes.items]) {
    const frame = shape.pixelRect;
    if (textOf(shape) && frame && frame.x >= 280 && frame.x < 800 && frame.y > 200 && frame.height <= 16) shape.delete();
  }

  const rewrites = [
    ["Team plan", "Team plan ✓"],
    ["Solo plan", "Solo plan ✓"],
    ["Decide later", "Decide later ✕"],
    ["Invite teammates", "Invite teammates ✓"],
    ["Skip invites", "Skip invites ✓"],
    ["Starter template", "Starter · UI changed"],
    ["Blank workspace", "Blank workspace ✕"],
    ["Import from CSV", "Import CSV · NEW"],
    ["Skip onboarding", "Skip onboarding · TBD"],
  ];
  for (const [oldText, newText] of rewrites) {
    const shape = findText(slide, oldText);
    const frame = shape.pixelRect;
    shape.text.set(newText);
    shape.position.set({ left: frame.x, top: frame.y + 8, width: frame.width, height: 25 });
    const color = oldText === "Import from CSV" ? C.blue :
      ["Decide later", "Blank workspace"].includes(oldText) ? C.red : C.ink;
    shape.text.style = {
      fontSize: oldText === "Skip onboarding" ? 16 : 17,
      bold: true,
      color,
      typeface: "Helvetica Neue",
      autoFit: "none",
    };
  }

  addLine(slide, 804, 202, 0, 408, C.rule, 1);
  addText(slide, "Stop resetting.\nStart branching.", 840, 226, 360, 100, 36, {
    bold: true,
    color: C.ink,
  });
  addText(slide, "One prepared state.\nEvery scenario.", 842, 350, 330, 66, 21, {
    color: C.muted,
  });
  addRect(slide, 842, 460, 350, 92, C.ink, { radius: 11 });
  addText(slide, "$ branchpoint run\n  --suite nimbus-onboarding", 866, 482, 306, 54, 17, {
    bold: true,
    color: "#78E4D0",
    typeface: "Courier New",
  });
  addText(slide, "Powered by Runloop", 842, 588, 300, 28, 18, {
    bold: true,
    color: C.tealDark,
  });
  setNotes(slide, [
    "The result tree maps the actual fixture hierarchy and reports intact journeys, app regressions, newly discovered paths, and unresolved branches.",
    "Close on the execution model: stop recreating state for every scenario; branch from one prepared state instead.",
  ], [
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/lib/fixtures.ts",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/cli/README.md",
  ]);
}

await fs.mkdir(RENDER_DIR, { recursive: true });
for (const [index, slide] of presentation.slides.items.entries()) {
  const stem = `slide-${String(index + 1).padStart(2, "0")}`;
  const png = await presentation.export({ slide, format: "png", scale: 1 });
  await fs.writeFile(`${RENDER_DIR}/${stem}.png`, new Uint8Array(await png.arrayBuffer()));
  const layout = await slide.export({ format: "layout" });
  await fs.writeFile(`${RENDER_DIR}/${stem}.layout.json`, await layout.text());
}
const montage = await presentation.export({ format: "webp", montage: true, scale: 1 });
await fs.writeFile(`${RENDER_DIR}/deck-montage.webp`, new Uint8Array(await montage.arrayBuffer()));
const pptx = await PresentationFile.exportPptx(presentation);
await pptx.save(OUT);
