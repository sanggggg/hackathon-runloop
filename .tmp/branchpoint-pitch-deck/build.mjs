import fs from "node:fs/promises";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const OUT = "/Users/sangmin/Desktop/hackathon-runloop/Branchpoint-Hackathon-Pitch.pptx";
const RENDER_DIR = "/Users/sangmin/Desktop/hackathon-runloop/.tmp/branchpoint-pitch-deck/output";
const SHOTS = "/Users/sangmin/Desktop/hackathon-runloop/apps/web/public/shots";
const SHOT_NAMES = ["team.png", "starter.png", "later.png", "v1-step2solo.png", "step2solo.png"];
const SHOT_BYTES = new Map();
for (const name of SHOT_NAMES) {
  SHOT_BYTES.set(`${SHOTS}/${name}`, await fs.readFile(`${SHOTS}/${name}`));
}

const W = 1280;
const H = 720;
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
  redTint: "#FCECEC",
  amber: "#B56A00",
};

const presentation = Presentation.create({ slideSize: { width: W, height: H } });

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
    autoFit: options.autoFit ?? "none",
  };
  return box;
}

function addRect(slide, x, y, w, h, fill, options = {}) {
  const geometry = options.geometry ?? "rect";
  return slide.shapes.add({
    geometry,
    name: options.name,
    position: { left: x, top: y, width: w, height: h },
    fill,
    line: options.line ?? { style: "solid", fill: options.stroke ?? "none", width: options.strokeWidth ?? 0 },
    ...(["rect", "textbox", "roundRect"].includes(geometry)
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

function addImage(slide, file, x, y, w, h, alt, options = {}) {
  if (options.backing !== false) {
    addRect(slide, x - 5, y - 5, w + 10, h + 10, C.white, {
      stroke: options.stroke ?? C.rule,
      strokeWidth: 1,
      radius: 12,
      shadow: options.shadow ?? "shadow-sm",
    });
  }
  return slide.images.add({
    blob: SHOT_BYTES.get(file),
    contentType: "image/png",
    alt,
    fit: options.fit ?? "cover",
    geometry: "roundRect",
    borderRadius: options.radius ?? 8,
    position: { left: x, top: y, width: w, height: h },
  });
}

function addHeader(slide, title, num, eyebrow = "BRANCHPOINT") {
  addText(slide, eyebrow, 48, 35, 300, 24, 14, { bold: true, color: C.teal });
  addText(slide, title, 48, 72, 1130, 72, 40, { bold: true, name: `slide-${num}-title` });
  addText(slide, String(num).padStart(2, "0"), 1182, 42, 50, 24, 13, { color: C.faint, align: "right" });
  addLine(slide, 48, 654, 1184, 0, C.rule, 1);
}

function setNotes(slide, lines, sources = []) {
  const noteText = [
    ...lines,
    "",
    "[Sources]",
    ...sources.map((s) => `- ${s}`),
    "[/Sources]",
  ].join("\n");
  slide.speakerNotes.textFrame.setText(noteText);
}

function addBrowserChrome(slide, x, y, w, h) {
  addRect(slide, x, y, w, h, "#F7F8F8", { stroke: C.rule, strokeWidth: 1, radius: 12 });
  addRect(slide, x, y, w, 26, "#E7EAEC", { radius: 12 });
  addRect(slide, x + 12, y + 9, 7, 7, "#FF6B6B", { geometry: "ellipse" });
  addRect(slide, x + 25, y + 9, 7, 7, "#FFD166", { geometry: "ellipse" });
  addRect(slide, x + 38, y + 9, 7, 7, "#4CC38A", { geometry: "ellipse" });
}

// 1 — cover / image field
{
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addText(slide, "BRANCHPOINT", 48, 42, 420, 28, 16, { bold: true, color: C.teal });
  addText(slide, "Browser QA,\nbranched at runtime.", 48, 118, 570, 190, 58, { bold: true, name: "cover-title" });
  addText(slide, "Prepare once. Fork every scenario.\nRe-run the whole tree on every commit.", 48, 352, 530, 92, 25, { color: C.muted });
  addText(slide, "Powered by Runloop", 48, 608, 300, 32, 18, { bold: true, color: C.tealDark });

  // Diagram connectors first.
  addLine(slide, 780, 210, 0, 270, C.teal, 3);
  addLine(slide, 780, 210, 90, 0, C.teal, 3);
  addLine(slide, 780, 345, 90, 0, C.teal, 3);
  addLine(slide, 780, 480, 90, 0, C.teal, 3);
  addRect(slide, 650, 298, 192, 96, C.ink, { radius: 12 });
  addText(slide, "ONE\nSNAPSHOT", 669, 316, 154, 62, 21, { bold: true, color: C.white, align: "center", valign: "middle" });

  addBrowserChrome(slide, 864, 114, 330, 206);
  addImage(slide, `${SHOTS}/team.png`, 870, 146, 318, 168, "Nimbus team-plan branch", { backing: false });
  addBrowserChrome(slide, 864, 257, 330, 206);
  addImage(slide, `${SHOTS}/starter.png`, 870, 289, 318, 168, "Nimbus starter-template branch", { backing: false });
  addBrowserChrome(slide, 864, 400, 330, 206);
  addImage(slide, `${SHOTS}/later.png`, 870, 432, 318, 168, "Nimbus decide-later branch", { backing: false });
  setNotes(slide, ["Open on the constraint: browser QA is valuable, but repeated setup makes scenario coverage too slow."], [
    "/Users/sangmin/Desktop/hackathon-runloop/README.md",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/public/shots/team.png",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/public/shots/starter.png",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/public/shots/later.png",
  ]);
}

// 2 — repeated setup problem
{
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "The test is short. Getting back to the right state is not.", 2);
  addText(slide, "Every scenario repeats the same expensive prelude.", 48, 151, 700, 34, 20, { color: C.muted });

  const labels = ["Install", "Boot app", "Create user", "Seed data", "Sign in", "Test"];
  const rowNames = ["Checkout", "Permissions", "Onboarding"];
  const widths = [110, 120, 142, 130, 112, 142];
  const startX = 250;
  const gap = 12;
  for (let r = 0; r < 3; r++) {
    const y = 244 + r * 112;
    addText(slide, rowNames[r], 48, y + 18, 170, 36, 22, { bold: true });
    let x = startX;
    for (let i = 0; i < labels.length; i++) {
      const final = i === labels.length - 1;
      addRect(slide, x, y, widths[i], 64, final ? C.teal : C.panel, {
        stroke: final ? C.teal : C.rule,
        strokeWidth: 1,
        radius: 8,
      });
      addText(slide, labels[i], x + 8, y + 18, widths[i] - 16, 28, 17, {
        bold: final,
        color: final ? C.white : C.muted,
        align: "center",
      });
      if (i < labels.length - 1) addText(slide, "→", x + widths[i], y + 17, gap, 28, 17, { color: C.faint, align: "center" });
      x += widths[i] + gap;
    }
  }
  addText(slide, "Setup dominates the wall clock — and grows with every path.", 250, 584, 780, 38, 24, { bold: true, color: C.red });
  setNotes(slide, ["Make the audience feel the duplicated setup before introducing the infrastructure primitive."], [
    "/Users/sangmin/Desktop/hackathon-runloop/README.md — Why fork",
  ]);
}

// 3 — measured speedup
{
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "With forks, wall clock follows tree depth—not path count.", 3);
  addText(slide, "MEASURED ON A REAL DEVBOX · 8 PATHS", 48, 159, 520, 26, 14, { bold: true, color: C.teal });

  addText(slide, "3m 30s", 48, 225, 360, 102, 76, { bold: true });
  addText(slide, "Sequential", 52, 329, 300, 30, 20, { color: C.muted });
  addRect(slide, 48, 389, 824, 54, C.ink, { radius: 4 });

  addText(slide, "16s", 48, 478, 260, 98, 76, { bold: true, color: C.tealDark });
  addText(slide, "Forked from one snapshot", 52, 582, 350, 30, 20, { color: C.muted });
  addRect(slide, 48, 631, 63, 12, C.teal, { radius: 4 });

  addText(slide, "~13×", 940, 250, 240, 100, 68, { bold: true, color: C.teal, align: "center" });
  addText(slide, "shorter\nwall clock", 940, 359, 240, 90, 28, { bold: true, align: "center" });
  addText(slide, "Same scenario tree.\nDifferent execution model.", 930, 500, 260, 72, 18, { color: C.muted, align: "center" });
  setNotes(slide, ["The 13× figure is derived from the measured examples: roughly 210 seconds sequential versus 16 seconds forked."], [
    "/Users/sangmin/Desktop/hackathon-runloop/README.md — Why fork",
  ]);
}

// 4 — architecture / branch flow
{
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "Snapshot only at real fork points.", 4);
  addText(slide, "Straight steps stay on one devbox. Nested branches snapshot again.", 48, 151, 860, 32, 20, { color: C.muted });

  // Recursive execution tree. Connectors are authored before nodes.
  addLine(slide, 228, 390, 42, 0, C.ink, 3);
  addLine(slide, 270, 246, 0, 305, C.teal, 3);
  addLine(slide, 270, 246, 60, 0, C.teal, 3);
  addLine(slide, 270, 391, 60, 0, C.teal, 3);
  addLine(slide, 270, 551, 60, 0, C.teal, 3);

  addLine(slide, 510, 246, 140, 0, C.teal, 2);
  addLine(slide, 650, 212, 0, 65, C.teal, 2);
  addLine(slide, 650, 212, 130, 0, C.teal, 2);
  addLine(slide, 650, 277, 130, 0, C.teal, 2);

  addLine(slide, 510, 391, 140, 0, C.teal, 2);
  addLine(slide, 650, 352, 0, 130, C.teal, 2);
  addLine(slide, 650, 352, 130, 0, C.teal, 2);
  addLine(slide, 650, 417, 130, 0, C.teal, 2);
  addLine(slide, 650, 482, 130, 0, C.teal, 2);

  addLine(slide, 510, 551, 270, 0, C.teal, 2);

  addRect(slide, 48, 345, 180, 90, C.ink, { radius: 12 });
  addText(slide, "SIGNED-IN\nFIXTURE", 66, 366, 144, 50, 19, { bold: true, color: C.white, align: "center" });

  const levelOne = [
    { y: 215, label: "Team plan" },
    { y: 360, label: "Solo plan" },
    { y: 520, label: "Decide later" },
  ];
  for (const node of levelOne) {
    addRect(slide, 330, node.y, 180, 62, C.tealTint, { stroke: C.teal, strokeWidth: 1, radius: 10 });
    addText(slide, node.label, 348, node.y + 18, 144, 26, 19, { bold: true, color: C.tealDark });
  }

  const leaves = [
    { y: 185, label: "Invite teammates" },
    { y: 250, label: "Skip invites" },
    { y: 325, label: "Starter template" },
    { y: 390, label: "Blank workspace" },
    { y: 455, label: "Import from CSV" },
    { y: 525, label: "Skip onboarding" },
  ];
  for (const leaf of leaves) {
    addRect(slide, 780, leaf.y, 260, 54, C.white, { stroke: C.rule, strokeWidth: 1, radius: 8 });
    addText(slide, leaf.label, 798, leaf.y + 15, 224, 24, 17, { bold: true });
  }

  const snaps = [
    { x: 247, y: 373 },
    { x: 627, y: 229 },
    { x: 627, y: 374 },
  ];
  for (const snap of snaps) {
    addRect(slide, snap.x - 5, snap.y, 56, 34, C.ink, { radius: 6 });
    addText(slide, "SNAP", snap.x - 1, snap.y + 10, 48, 16, 8, { bold: true, color: "#78E4D0", align: "center" });
  }
  addText(slide, "snapshot", 1070, 202, 120, 22, 13, { bold: true, color: C.ink });
  addText(slide, "only where a node\nhas 2+ children", 1070, 232, 150, 48, 15, { color: C.muted });
  addText(slide, "same box", 1070, 342, 120, 22, 13, { bold: true, color: C.tealDark });
  addText(slide, "for a straight\nsingle-child run", 1070, 372, 150, 48, 15, { color: C.muted });
  addText(slide, "Fixture tree · 3 levels", 1070, 536, 150, 26, 15, { bold: true, color: C.tealDark });
  setNotes(slide, ["The orchestrator is recursive: snapshot only when a node has two or more children. The fixture already models nested branches; full recursive orchestration wiring is still in progress."], [
    "/Users/sangmin/Desktop/hackathon-runloop/docs/build-spec.html — Engine: how a run walks the tree",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/lib/fixtures.ts",
  ]);
}

// 5 — intent resilience with real screenshots
{
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "Selectors break. Intent survives.", 5);
  addText(slide, "The control changed. The user journey did not.", 48, 151, 700, 34, 20, { color: C.muted });

  addText(slide, "BEFORE", 48, 209, 130, 24, 14, { bold: true, color: C.faint });
  addText(slide, "AFTER", 656, 209, 130, 24, 14, { bold: true, color: C.teal });
  addImage(slide, `${SHOTS}/v1-step2solo.png`, 48, 245, 560, 350, "Nimbus baseline starting-point screen");
  addImage(slide, `${SHOTS}/step2solo.png`, 656, 245, 560, 350, "Nimbus updated starting-point screen");

  addRect(slide, 70, 522, 250, 52, C.redTint, { stroke: C.red, strokeWidth: 1, radius: 8 });
  addText(slide, "#starter-template  ✕", 86, 538, 218, 22, 17, { bold: true, color: C.red });
  addRect(slide, 678, 522, 330, 52, C.tealTint, { stroke: C.teal, strokeWidth: 1, radius: 8 });
  addText(slide, '"Pick the prepared template"  ✓', 694, 538, 300, 22, 17, { bold: true, color: C.tealDark });
  setNotes(slide, ["The baseline label is 'Starter template'; the changed UI says 'Use a starter'. Branchpoint records intent and reports the path as passing with UI changed."], [
    "/Users/sangmin/Desktop/hackathon-runloop/README.md — The pitch, in one line",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/public/shots/v1-step2solo.png",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/public/shots/step2solo.png",
  ]);
}

// 6 — visual result tree
{
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addHeader(slide, "A commit becomes a visual QA tree.", 6);
  addText(slide, "Green: journey intact · Red: app regression · Blue: newly discovered path", 48, 151, 930, 30, 19, { color: C.muted });

  // Nested result tree. Connectors first.
  addLine(slide, 208, 392, 32, 0, C.rule, 2);
  addLine(slide, 240, 239, 0, 310, C.rule, 2);
  addLine(slide, 240, 239, 40, 0, C.rule, 2);
  addLine(slide, 240, 394, 40, 0, C.rule, 2);
  addLine(slide, 240, 549, 40, 0, C.red, 2);

  addLine(slide, 450, 239, 40, 0, C.teal, 2);
  addLine(slide, 490, 217, 0, 60, C.teal, 2);
  addLine(slide, 490, 217, 50, 0, C.teal, 2);
  addLine(slide, 490, 277, 50, 0, C.teal, 2);

  addLine(slide, 450, 394, 40, 0, C.teal, 2);
  addLine(slide, 490, 352, 0, 120, C.teal, 2);
  addLine(slide, 490, 352, 50, 0, C.teal, 2);
  addLine(slide, 490, 412, 50, 0, C.red, 2);
  addLine(slide, 490, 472, 50, 0, C.blue, 2);

  addLine(slide, 450, 549, 90, 0, C.rule, 2);

  addRect(slide, 48, 351, 160, 82, C.ink, { radius: 10 });
  addText(slide, "SIGNED-IN\nFIXTURE", 61, 370, 134, 46, 17, { bold: true, color: C.white, align: "center" });

  const branchRows = [
    { y: 210, title: "Team plan", status: "PASS", color: C.teal },
    { y: 365, title: "Solo plan", status: "PASS", color: C.teal },
    { y: 520, title: "Decide later", status: "FAIL", color: C.red },
  ];
  for (const row of branchRows) {
    addRect(slide, 280, row.y, 170, 58, C.white, { stroke: row.color, strokeWidth: 2, radius: 9 });
    addText(slide, row.title, 295, row.y + 9, 140, 22, 17, { bold: true });
    addText(slide, row.status, 295, row.y + 35, 140, 15, 11, { bold: true, color: row.color });
  }

  const resultLeaves = [
    { y: 190, title: "Invite teammates", status: "PASS", color: C.teal, fill: C.tealTint },
    { y: 250, title: "Skip invites", status: "PASS", color: C.teal, fill: C.tealTint },
    { y: 325, title: "Starter template", status: "PASS · UI CHANGED", color: C.teal, fill: C.tealTint },
    { y: 385, title: "Blank workspace", status: "FAIL", color: C.red, fill: C.redTint },
    { y: 445, title: "Import from CSV", status: "NEW PATH", color: C.blue, fill: "#EAF2FF" },
    { y: 520, title: "Skip onboarding", status: "UNRESOLVED TREE", color: C.faint, fill: C.panel },
  ];
  for (const leaf of resultLeaves) {
    addRect(slide, 540, leaf.y, 235, 54, leaf.fill, { stroke: leaf.color, strokeWidth: 1, radius: 8 });
    addText(slide, leaf.title, 555, leaf.y + 8, 205, 20, 15, { bold: true });
    addText(slide, leaf.status, 555, leaf.y + 32, 205, 13, 10, { bold: true, color: leaf.color });
  }

  addImage(slide, `${SHOTS}/starter.png`, 835, 205, 330, 206, "Nimbus starter-template branch that passed after a UI change");
  addImage(slide, `${SHOTS}/later.png`, 835, 430, 330, 206, "Nimbus decide-later branch that reached an error screen");
  addText(slide, "intent\nsurvived", 1168, 274, 96, 44, 11, { bold: true, color: C.teal, align: "center" });
  addText(slide, "app\nbroke", 1168, 500, 96, 44, 11, { bold: true, color: C.red, align: "center" });
  setNotes(slide, ["This reflects the actual fixture hierarchy: root, plan choice, then terminal journeys. A UI change can remain green; an error screen is red; discovery is blue; unresolved wording is tree health, not app failure."], [
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/lib/fixtures.ts",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/public/shots/starter.png",
    "/Users/sangmin/Desktop/hackathon-runloop/apps/web/public/shots/later.png",
  ]);
}

// 7 — measured three-way comparison
{
  const slide = presentation.slides.add();
  slide.background.fill = C.ink;
  addText(slide, "BRANCHPOINT", 48, 35, 300, 24, 14, { bold: true, color: "#78E4D0" });
  addText(slide, "The sweet spot: fan-out speed without fan-out waste.", 48, 78, 1130, 72, 40, { bold: true, color: C.white, name: "slide-7-title" });
  addText(slide, "3 controlled runs · Trials 1–3 · cold cache before every method · same model, task, tools, and fixture", 48, 159, 1080, 32, 19, { color: "#B7C0C5" });

  const columns = [
    { x: 48, w: 340, title: "METHOD" },
    { x: 420, w: 230, title: "ACTIVE SANDBOX" },
    { x: 690, w: 210, title: "WALL TIME" },
    { x: 950, w: 210, title: "LLM COST" },
  ];
  for (const col of columns) {
    addText(slide, col.title, col.x, 218, col.w, 20, 12, { bold: true, color: "#8F9AA0" });
  }
  addLine(slide, 48, 248, 1136, 0, "#586268", 1);

  const rows = [
    {
      y: 260, fill: "#123B35", stroke: "#3CBFA5", color: "#78E4D0",
      method: "Branchpoint", detail: "shared prefix · 78.0% cache read · 13.7 req",
      sandbox: "200s", sandboxRange: "180–240",
      wall: "66.8s", wallRange: "57.1–84.7",
      cost: "$0.150", costRange: "$0.115–0.196",
    },
    {
      y: 365, fill: "#20262A", stroke: "#586268", color: C.white,
      method: "1 sandbox · sequential", detail: "full path × 3 · 77.4% cache read · 25.3 req",
      sandbox: "200s", sandboxRange: "180–240",
      wall: "171.6s", wallRange: "141.8–226.1",
      cost: "$0.198", costRange: "$0.160–0.260",
    },
    {
      y: 470, fill: "#20262A", stroke: "#586268", color: C.white,
      method: "N sandboxes · fan-out", detail: "full path × 3 · 74.3% cache read · 22.3 req",
      sandbox: "220s", sandboxRange: "180–240",
      wall: "76.1s", wallRange: "50.9–111.8",
      cost: "$0.188", costRange: "$0.152–0.243",
    },
  ];
  for (const row of rows) {
    addRect(slide, 38, row.y, 1156, 88, row.fill, { stroke: row.stroke, strokeWidth: 1, radius: 10 });
    addText(slide, row.method, 58, row.y + 14, 320, 28, 21, { bold: true, color: row.color });
    addText(slide, row.detail, 58, row.y + 50, 335, 20, 12, { color: "#AAB4B9" });

    addText(slide, row.sandbox, 420, row.y + 12, 230, 38, 29, { bold: true, color: row.color });
    addText(slide, row.sandboxRange, 420, row.y + 55, 230, 18, 12, { color: "#AAB4B9" });
    addText(slide, row.wall, 690, row.y + 12, 210, 38, 29, { bold: true, color: row.color });
    addText(slide, row.wallRange, 690, row.y + 55, 210, 18, 12, { color: "#AAB4B9" });
    addText(slide, row.cost, 950, row.y + 12, 210, 38, 29, { bold: true, color: row.color });
    addText(slide, row.costRange, 950, row.y + 55, 210, 18, 12, { color: "#AAB4B9" });
  }

  addText(slide, "vs sequential  ·  wall −61.1%  ·  LLM −24.2%  ·  sandbox equal", 48, 579, 550, 24, 15, { bold: true, color: "#78E4D0" });
  addText(slide, "vs fan-out  ·  wall −12.2%  ·  sandbox −9.1%  ·  LLM −20.3%", 640, 579, 544, 24, 15, { bold: true, color: "#78E4D0", align: "right" });
  addText(slide, "Mean (min–max) · n=3, Trials 1–3 · 9/9 branches per method passed 8/8 · Runloop /usage", 48, 620, 1090, 24, 14, { color: "#8F9AA0" });
  addText(slide, "07", 1182, 620, 50, 24, 13, { color: "#8F9AA0", align: "right" });
  setNotes(slide, ["This pitch view uses the first three consecutive controlled trials (Trials 1–3) and excludes Trials 4–5 from the slide's calculations. The three included trials compared the same Claude Sonnet 5 model, tools, task, three strategy prompts, and task-ready Runloop fixture. Immediately before every method in every trial, a unique nonce invalidated earlier provider prompt-cache entries; within that method, Anthropic's 5-minute ephemeral prompt cache remained enabled. OpenRouter whole-response caching was disabled and a sticky session kept requests on one provider endpoint. Branchpoint explored once, snapshotted, continued on the source devbox for one branch, and created only N-1 forks; sequential reset the task and ran all three complete trajectories on one devbox; fan-out ran three complete trajectories on three devboxes. Primary wall time is start-to-final-verdict. Sandbox time is the sum of Runloop /usage total_active_seconds after shutdown. LLM cost is the actual Anthropic upstream inference cost returned by OpenRouter for this BYOK account, including cache read/write pricing. Three-run means: Branchpoint 66.787s wall, 200 active sandbox-seconds, $0.150097 LLM cost; sequential 171.573s, 200s, $0.197894; fan-out 76.079s, 220s, $0.188262. Every method passed all three 8-test branches in all three included trials. Observed cache-read ratios were 77.99%, 77.39%, and 74.30% respectively."], [
    "/Users/sangmin/Desktop/hackathon-runloop/experiments/three-way-benchmark.py",
    "/Users/sangmin/Desktop/hackathon-runloop/experiments/three-way-benchmark-trials-1-3.json",
    "https://docs.runloop.ai/api-reference/devbox/get-resource-usage-for-a-devbox",
    "https://openrouter.ai/docs/guides/best-practices/prompt-caching",
    "https://openrouter.ai/docs/cookbook/administration/usage-accounting",
  ]);
}

// 8 — close
{
  const slide = presentation.slides.add();
  slide.background.fill = C.white;
  addText(slide, "BRANCHPOINT", 48, 42, 300, 28, 16, { bold: true, color: C.teal });
  addText(slide, "Stop resetting.\nStart branching.", 48, 128, 720, 170, 64, { bold: true, name: "closing-title" });
  addText(slide, "Scenario-based Browser QA that is fast enough to run on every commit.", 48, 345, 760, 68, 25, { color: C.muted });

  addRect(slide, 48, 485, 860, 92, C.ink, { radius: 12 });
  addText(slide, "$ branchpoint run --suite nimbus-onboarding --wait", 74, 517, 808, 30, 22, { bold: true, color: "#78E4D0", typeface: "Courier New" });

  addRect(slide, 978, 164, 204, 204, C.tealTint, { stroke: C.teal, strokeWidth: 2, radius: 102 });
  addText(slide, "1 → N", 1006, 224, 148, 64, 42, { bold: true, color: C.tealDark, align: "center" });
  addText(slide, "one state\nevery path", 1006, 296, 148, 52, 17, { color: C.tealDark, align: "center" });
  addText(slide, "Powered by Runloop", 978, 432, 204, 28, 18, { bold: true, color: C.tealDark, align: "center" });
  addText(slide, "github.com/sanggggg/hackathon-runloop", 48, 627, 500, 22, 15, { color: C.faint });
  setNotes(slide, ["Close by returning to the execution model: one prepared state, every scenario, in parallel."], [
    "/Users/sangmin/Desktop/hackathon-runloop/README.md",
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
