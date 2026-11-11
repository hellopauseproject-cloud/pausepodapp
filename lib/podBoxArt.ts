/**
 * Lådan ritad som geometri — ren data, ingen React.
 *
 * Ritningen bor här och inte i komponenten
 * ([components/pod-box-stage.tsx](../components/pod-box-stage.tsx)) av två
 * skäl. Den ena är att lådan är fem lager som rör sig var för sig (inredningen,
 * telefonen, kroppen, locket fram och locket bak), och de måste dela exakt
 * samma projektion för att hänga ihop. Den andra är att samma data går att
 * rendera till en bild utanför appen, och det är så ritningen prövas mot
 * fotona.
 *
 * **Projektionen är sned (kavaljer), inte perspektiv.** Lådans framsida ligger
 * i bildplanet och djupet går snett uppåt höger (`KX`, `KY`). Det är så
 * fotona är tagna — rakt framifrån, lite ovanifrån, med högra gaveln synlig —
 * och det gör att framsidan och displayen förblir raka rektanglar, så att
 * skärmens innehåll kan ritas som vanliga vyer ovanpå.
 *
 * Måtten följer fotona: framsidan ungefär 2,4 gånger så bred som lådan är hög
 * med lock, ljus ek med ådring på längden, rundade kanter, två lodräta
 * skåror på gaveln (pausens streck) och displayen nere i mitten i en smal
 * platt ram i mörkt grått.
 */

export const VIEW_W = 360;
export const VIEW_H = 300;

// Snedprojektionens djupriktning: en enhet djup flyttar så här långt åt höger
// och uppåt på skärmen.
const KX = 0.34;
const KY = 0.3;
const OX = 42;
const OY = 248;

/** Lådan i egna enheter: bredd, kroppens höjd, djup, lockets höjd, väggens tjocklek, bottnens höjd. */
export const BOX = { W: 236, H: 74, D: 118, LID: 12, T: 8, F: 6 };

/** Telefonen ligger skärmen nedåt; `HOVER_Y` är dess undersida när den hålls ovanför lådan. */
const PHONE = { x0: 46, x1: 196, z0: 20, z1: 92, thick: 7, HOVER_Y: 140 };

/** Hur långt telefonen sjunker på skärmen från att hållas ovanför till att ligga i botten. */
export const PHONE_DROP = PHONE.HOVER_Y - BOX.F;

export type Pt = [number, number];
export const project = (x: number, y: number, z: number): Pt => [OX + x + z * KX, OY - y - z * KY];

export type Prim = {
  d: string;
  fill?: string;
  opacity?: number;
  stroke?: string;
  sw?: number;
  evenOdd?: boolean;
};

export type Stop = [offset: number, color: string, opacity?: number];
export type Grad =
  | { id: string; kind: 'linear'; x1: number; y1: number; x2: number; y2: number; stops: Stop[] }
  | { id: string; kind: 'radial'; cx: number; cy: number; rx: number; ry: number; stops: Stop[] };

export type Art = {
  grads: Grad[];
  shadow: Prim[];
  interior: Prim[];
  phone: Prim[];
  /** Telefonen med skärmen upp, samma kontur. */
  phoneFront: Prim[];
  /** Skenet runt taggen, som scenen pulserar när kameran står på den. */
  tagGlow: Prim[];
  /** Pause-dekalen på telefonens rygg, ett eget lager så att den kan klistras på. */
  tag: Prim[];
  /** Var dekalen sitter på skärmen, för dess eget lager i scenen. */
  tagCenter: Pt;
  body: Prim[];
  lid: Prim[];
  /** Displayens synliga yta, i vyns enheter. */
  screen: { x: number; y: number; w: number; h: number };
  /** Mitten av taggen när telefonen hålls ovanför lådan — dit kameran zoomar. */
  phoneFocus: Pt;
  /** Mitten av telefonen som hålls ovanför lådan, och dess längd och djup på skärmen. */
  phoneCenter: Pt;
  phoneLength: number;
  phoneDepth: number;
};

// ─── Hjälpare ──────────────────────────────────────────────

const f = (n: number) => Math.round(n * 100) / 100;
const pathOf = (pts: Pt[], close = true) =>
  pts.map((p, i) => `${i ? 'L' : 'M'}${f(p[0])} ${f(p[1])}`).join('') + (close ? 'Z' : '');

/** Deterministisk slump, så att ådringen ser likadan ut varje gång. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * En rundad rektangel i ett plan, projicerad. `plane(u, v)` ger punkten i
 * lådans koordinater; hörnradierna går moturs från (u0, v0).
 */
function roundedFace(
  plane: (u: number, v: number) => Pt,
  u0: number, u1: number, v0: number, v1: number,
  r: [number, number, number, number],
): Pt[] {
  const pts: Pt[] = [];
  const corners: [number, number, number, number][] = [
    // cu, cv, startvinkel, radie
    [u0 + r[0], v0 + r[0], Math.PI, r[0]],
    [u1 - r[1], v0 + r[1], 1.5 * Math.PI, r[1]],
    [u1 - r[2], v1 - r[2], 0, r[2]],
    [u0 + r[3], v1 - r[3], 0.5 * Math.PI, r[3]],
  ];
  for (const [cu, cv, a0, rad] of corners) {
    const steps = rad > 0 ? 6 : 0;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (i / Math.max(steps, 1)) * 0.5 * Math.PI;
      pts.push(plane(cu + Math.cos(a) * rad, cv + Math.sin(a) * rad));
    }
  }
  return pts;
}

const front = (z: number) => (u: number, v: number) => project(u, v, z);     // u = x, v = y
const side = (x: number) => (u: number, v: number) => project(x, v, u);      // u = z, v = y
const top = (y: number) => (u: number, v: number) => project(u, y, v);       // u = x, v = z

function ellipseInPlane(plane: (u: number, v: number) => Pt, cu: number, cv: number, r: number, n = 28): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push(plane(cu + Math.cos(a) * r, cv + Math.sin(a) * r));
  }
  return pts;
}

/**
 * Ådring: tunna, lätt vågiga linjer längs `u`, i ett plan. Mörka linjer för
 * årsringarna och några ljusa för märgstrålarna som glänser i ek.
 */
function grain(
  plane: (u: number, v: number) => Pt,
  u0: number, u1: number, v0: number, v1: number,
  count: number, seed: number,
): Prim[] {
  const r = rng(seed);
  const out: Prim[] = [];
  for (let i = 0; i < count; i++) {
    const v = v0 + 1.5 + r() * (v1 - v0 - 3);
    const a1 = 0.1 + r() * 0.35, a2 = 0.05 + r() * 0.2;
    const f1 = 0.02 + r() * 0.03, f2 = 0.07 + r() * 0.08;
    const p1 = r() * 6, p2 = r() * 6;
    // Linjen börjar och slutar inte alltid i kanten — riktiga fibrer gör inte det.
    const s = u0 + 2 + (r() < 0.6 ? 0 : r() * (u1 - u0) * 0.4);
    const e = u1 - 2 - (r() < 0.6 ? 0 : r() * (u1 - u0) * 0.4);
    const pts: Pt[] = [];
    for (let u = s; u <= e; u += 6) {
      const vv = Math.max(v0 + 0.6, Math.min(v1 - 0.6, v + a1 * Math.sin(u * f1 + p1) + a2 * Math.sin(u * f2 + p2)));
      pts.push(plane(u, vv));
    }
    const light = r() < 0.16;
    out.push({
      d: pathOf(pts, false),
      stroke: light ? '#fff6e6' : '#7a4f26',
      sw: light ? 0.4 + r() * 0.5 : 0.25 + r() * 0.55,
      opacity: light ? 0.14 + r() * 0.12 : 0.04 + r() * 0.1,
    });
  }
  return out;
}

// ─── Ritningen ─────────────────────────────────────────────

export function buildPodBoxArt(): Art {
  const { W, H, D, LID, T, F } = BOX;
  const grads: Grad[] = [];
  const lin = (id: string, a: Pt, b: Pt, stops: Stop[]) => {
    grads.push({ id, kind: 'linear', x1: a[0], y1: a[1], x2: b[0], y2: b[1], stops });
    return `url(#${id})`;
  };
  const rad = (id: string, c: Pt, rx: number, ry: number, stops: Stop[]) => {
    grads.push({ id, kind: 'radial', cx: c[0], cy: c[1], rx, ry, stops });
    return `url(#${id})`;
  };

  // ── Skuggan: en mjuk skugga under lådan och en tät linje där den står ──
  const [scx, scy] = project(W / 2, 0, D / 2);
  const shadow: Prim[] = [
    { d: ellipsePath(scx + 6, scy + 6, 190, 44), fill: rad('pbShadowSoft', [scx + 6, scy + 6], 190, 44, [[0, '#000', 0.34], [0.6, '#000', 0.12], [1, '#000', 0]]) },
    { d: ellipsePath(scx, project(W / 2, 0, 0)[1] - 6, 150, 14), fill: rad('pbShadowNear', [scx, project(W / 2, 0, 0)[1] - 6], 150, 14, [[0, '#000', 0.32], [1, '#000', 0]]) },
  ];
  // Fötterna, två som syns.
  for (const fx of [16, W - 16]) {
    const [x, y] = project(fx, 0, 4);
    shadow.push({ d: ellipsePath(x, y + 1.2, 7, 2.4), fill: '#2b241d', opacity: 0.9 });
  }

  // ── Inredningen: botten, bakväggen och vänster innervägg ──
  const floor = roundedFace(top(F), T, W - T, T, D - T, [0, 0, 0, 0]);
  const back = roundedFace(front(D - T), T, W - T, F, H, [0, 0, 0, 0]);
  const leftWall = roundedFace(side(T), T, D - T, F, H, [0, 0, 0, 0]);
  const interior: Prim[] = [
    { d: pathOf(floor), fill: '#6a4d30' },
    { d: pathOf(back), fill: lin('pbBack', project(0, H, D - T), project(0, F + 20, D - T), [[0, '#d2b48a'], [1, '#8b6a44']]) },
    { d: pathOf(leftWall), fill: lin('pbLeft', project(T, H, D / 2), project(T, F + 18, D / 2), [[0, '#b99668'], [1, '#6d5034']]) },
    // Hörnet där väggarna möts är mörkare.
    { d: pathOf([project(T, H, D - T), project(T, F, D - T)], false), stroke: '#4a321c', sw: 1.2, opacity: 0.35 },
    ...grain(front(D - T), T, W - T, F + 30, H, 9, 41),
  ];

  // ── Telefonen, hållen ovanför lådan: ryggen med taggen upp (`phone`)
  // eller skärmen upp (`phoneFront`). Den vänds innan den läggs ner, så att
  // taggen pekar nedåt mot lådans läsare. ──
  const P = PHONE;
  const py = P.HOVER_Y;
  const phoneFace = (y: number) => roundedFace(top(y), P.x0, P.x1, P.z0, P.z1, [9, 9, 9, 9]);
  const phoneEdge: Prim[] = [];
  // Tjockleken: samma kontur staplad nedåt, så att kanterna sveper ihop.
  for (let i = 0; i < 6; i++) {
    phoneEdge.push({ d: pathOf(phoneFace(py + (P.thick * i) / 6)), fill: '#16181c' });
  }
  const top0 = py + P.thick;
  const phone: Prim[] = [...phoneEdge];
  const phoneFront: Prim[] = [
    ...phoneEdge,
    { d: pathOf(phoneFace(top0)), fill: '#05070b' },
    { d: pathOf(phoneFace(top0)), stroke: '#8b939d', sw: 0.7, opacity: 0.55 },
    // Den släckta skärmen innanför ramen, och glasets reflex.
    { d: pathOf(roundedFace(top(top0), P.x0 + 4, P.x1 - 4, P.z0 + 4, P.z1 - 4, [7, 7, 7, 7])), fill: lin('pbScreen', project(P.x0, top0, P.z1), project(P.x1, top0, P.z0), [[0, '#16223d'], [0.5, '#0a0f1c'], [1, '#05070b']]) },
    { d: pathOf(roundedFace(top(top0), P.x0 + 9, P.x0 + 16, P.z0 + 26, P.z1 - 26, [3.5, 3.5, 3.5, 3.5])), fill: '#000000' },
    { d: pathOf([project(P.x0 + 20, top0, P.z1 - 4), project(P.x0 + 58, top0, P.z1 - 4), project(P.x0 + 36, top0, P.z0 + 4), project(P.x0 + 6, top0, P.z0 + 4)]), fill: '#ffffff', opacity: 0.06 },
  ];
  phone.push(
    { d: pathOf(phoneFace(top0)), fill: lin('pbPhone', project(P.x0, top0, P.z1), project(P.x1, top0, P.z0), [[0, '#454b54'], [0.55, '#2b3037'], [1, '#1d2127']]) },
    // En mjuk reflex över glasryggen.
    { d: pathOf(roundedFace(top(top0), P.x0 + 30, P.x0 + 70, P.z0 + 4, P.z1 - 4, [8, 8, 8, 8])), fill: '#ffffff', opacity: 0.05 },
    { d: pathOf(phoneFace(top0)), stroke: '#8b939d', sw: 0.7, opacity: 0.55 },
  );
  // Kameran.
  const bump = roundedFace(top(top0 + 1), P.x0 + 8, P.x0 + 40, P.z1 - 32, P.z1 - 6, [7, 7, 7, 7]);
  phone.push({ d: pathOf(bump), fill: '#2f343b', stroke: '#596069', sw: 0.6 });
  for (const [cx, cz] of [[P.x0 + 17, P.z1 - 14], [P.x0 + 31, P.z1 - 14], [P.x0 + 17, P.z1 - 25]]) {
    phone.push({ d: pathOf(ellipseInPlane(top(top0 + 1.5), cx, cz, 5)), fill: '#0b0d11', stroke: '#6b737d', sw: 0.8 });
    phone.push({ d: pathOf(ellipseInPlane(top(top0 + 1.5), cx - 1.2, cz + 1.4, 1.4)), fill: '#9fb4d8', opacity: 0.5 });
  }
  // Pause-taggen: en rund dekal i appikonens stil — pausens två streck som
  // upplyst glas, ljusa upptill och djupare nedtill, med ett sken bakom, på
  // en navy som mörknar nedåt (assets/images/icon.png).
  // Längst ner på telefonen: kameran sitter i `x0`-änden, som är toppen.
  const tagC = { x: P.x1 - 24, z: 56 };
  const tz = top0 + 0.5;
  const bar = (x0: number, x1: number, grow = 0) =>
    pathOf(roundedFace(top(tz + 0.1), x0 - grow, x1 + grow, tagC.z - 7.5 - grow, tagC.z + 7.5 + grow, [1.8 + grow, 1.8 + grow, 1.8 + grow, 1.8 + grow]));
  // Dekalen är ett eget lager (`tag`), så att den kan klistras på i scenen.
  const tag: Prim[] = [
    { d: pathOf(ellipseInPlane(top(top0 + 0.4), tagC.x + 0.8, tagC.z - 1.2, 16.5)), fill: '#000', opacity: 0.35 },
    // En ljus kant runt dekalen, så att den syns mot den mörka glasryggen.
    { d: pathOf(ellipseInPlane(top(tz), tagC.x, tagC.z, 16.3)), fill: lin('pbTagRim', project(tagC.x, tz, tagC.z + 16), project(tagC.x, tz, tagC.z - 16), [[0, '#f4f8ff'], [1, '#9fb3cf']]) },
    { d: pathOf(ellipseInPlane(top(tz), tagC.x, tagC.z, 15)), fill: lin('pbTag', project(tagC.x, tz, tagC.z + 15), project(tagC.x, tz, tagC.z - 15), [[0, '#2b4b98'], [0.55, '#1a3172'], [1, '#0b1636']]) },
    // PAUSE-glöden bakom strecken.
    { d: pathOf(ellipseInPlane(top(tz), tagC.x, tagC.z, 11)), fill: rad('pbTagGlow', project(tagC.x, tz, tagC.z), 11, 4, [[0, '#4f86c6', 0.75], [1, '#4f86c6', 0]]) },
    // Strecken: ett mjukt sken runt, sedan glaset.
    { d: bar(tagC.x - 6, tagC.x - 2, 1.4), fill: '#9fd0ff', opacity: 0.22 },
    { d: bar(tagC.x + 2, tagC.x + 6, 1.4), fill: '#9fd0ff', opacity: 0.22 },
    { d: bar(tagC.x - 6, tagC.x - 2), fill: lin('pbTagBar', project(tagC.x, tz, tagC.z + 7.5), project(tagC.x, tz, tagC.z - 7.5), [[0, '#e6f2ff'], [0.45, '#a6d0ff'], [1, '#5e9de6']]) },
    { d: bar(tagC.x + 2, tagC.x + 6), fill: 'url(#pbTagBar)' },
    { d: pathOf(ellipseInPlane(top(tz), tagC.x, tagC.z, 15)), stroke: '#8cbcff', sw: 0.5, opacity: 0.45 },
  ];
  // Skenet på dekalens plats när kameran visar den: fyllda ellipser staplade
  // på varandra och inte en radiell toning — en utdragen radiell toning
  // ritades inte av react-native-svg. Där de överlappar, i mitten, är skenet
  // starkast. Utan dekal visar det var den ska sitta; med dekal ligger den
  // ovanpå skenet (eget lager i scenen) och bleks inte.
  const tagGlow: Prim[] = Array.from({ length: 18 }, (_, i) => ({
    d: pathOf(ellipseInPlane(top(tz), tagC.x, tagC.z, 17 + i * 0.6)),
    fill: '#8cc4ff',
    opacity: 0.035,
  }));

  // ── Kroppen: framsidan, gaveln, väggarnas överkant, displayen, skårorna ──
  // Nere till höger är hörnet nästan rakt, som gavelns: där fortsätter
  // underkanten in i gaveln, och en rundning hade lämnat gavelns hörn som en
  // spets under den. Till vänster syns ingen gavel, och där får hörnet runda.
  const frontFace = roundedFace(front(0), 0, W, 0, H, [6, 1.5, 1.5, 1.5]);
  const sideFace = roundedFace(side(W), 0, D, 0, H, [1.5, 3, 1.5, 1.5]);
  const rimOuter = roundedFace(top(H), 0, W, 0, D, [3, 3, 3, 3]);
  const rimInner = roundedFace(top(H), T, W - T, T, D - T, [1, 1, 1, 1]);
  const body: Prim[] = [
    { d: pathOf(sideFace), fill: lin('pbSide', project(W, H, 0), project(W, 0, D), [[0, '#cdae82'], [1, '#a88559']]) },
    ...grain(side(W), 0, D, 0, H, 34, 7),
    { d: pathOf(frontFace), fill: lin('pbFront', project(0, H, 0), project(0, 0, 0), [[0, '#e2c8a2'], [0.7, '#d2b388'], [1, '#c3a173']]) },
    ...grain(front(0), 0, W, 0, H, 64, 3),
    // Fönsterljuset från vänster tonar ut över framsidan.
    { d: pathOf(frontFace), fill: lin('pbLight', project(0, H / 2, 0), project(W, H / 2, 0), [[0, '#fff8ec', 0.16], [0.5, '#fff8ec', 0], [1, '#3a2510', 0.06]]) },
    // Den rundade lodräta kanten mellan framsida och gavel fångar ljuset.
    { d: pathOf(roundedFace(front(0), W - 7, W, 1, H - 1, [0, 1.5, 0, 0])), fill: lin('pbEdge', project(W - 7, 0, 0), project(W, 0, 0), [[0, '#fff3dd', 0], [0.6, '#fff3dd', 0.35], [1, '#b8946a', 0.3]]) },
    { d: pathOf(roundedFace(front(0), 0, 5, 1, H - 1, [5, 0, 0, 0])), fill: lin('pbEdgeL', project(0, 0, 0), project(5, 0, 0), [[0, '#8a6a44', 0.28], [1, '#8a6a44', 0]]) },
    // Studsljus från bordet nederst.
    { d: pathOf(roundedFace(front(0), 0, W, 0, 9, [6, 1.5, 0, 0])), fill: lin('pbFoot', project(0, 0, 0), project(0, 9, 0), [[0, '#3a2510', 0.22], [1, '#3a2510', 0]]) },
    // Väggarnas överkant, ändträ, syns när locket är av.
    { d: pathOf(rimOuter) + pathOf(rimInner), fill: '#e9d4b0', evenOdd: true },
    { d: pathOf(rimInner), stroke: '#8a6a44', sw: 0.7, opacity: 0.45 },
    // Skarven under locket.
    { d: pathOf([project(1, H, 0), project(W, H, 0), project(W, H, D - 1)], false), stroke: '#5c3f22', sw: 1, opacity: 0.4 },
  ];

  // Skårorna på gaveln — pausens två streck, utsågade i träet.
  for (const zc of [D / 2 - 9, D / 2 + 9]) {
    const slot = roundedFace(side(W), zc - 3.2, zc + 3.2, 24, 56, [3.2, 3.2, 3.2, 3.2]);
    const lip = roundedFace(side(W), zc - 3.2, zc + 3.2, 23, 27, [2, 2, 2, 2]);
    body.push(
      { d: pathOf(lip), fill: '#f0dcbc', opacity: 0.7 },
      { d: pathOf(slot), fill: lin(`pbSlot${zc}`, project(W, 56, zc), project(W, 24, zc), [[0, '#2a1a0c'], [1, '#5a3c20']]) },
    );
  }

  // Displayen: en tunn, platt ram i mörkt grått ända in till skärmen (på
  // begäran: först polerat silver med fasning och glans, sedan platt). Ramen
  // täcker akrylkanterna — skärmen sitter direkt i den.
  const scr = { u0: 86, u1: 150, v0: 21, v1: 41 };
  const R = (a: number) => [a, a, a, a] as [number, number, number, number];
  const face = (g: number, r: number) => roundedFace(front(0), scr.u0 - g, scr.u1 + g, scr.v0 - g, scr.v1 + g, R(r));
  const frameOuter = face(3.2, 1.8);
  const frameInner = face(1.6, 0.8);
  // Skärmen sitter en halv centimeter in i lådan (`SINK`), inte i ramens plan.
  // Sett lite ovanifrån och från höger syns då urtagets botten och vänstra
  // vägg, och ramen skär över skärmens övre och högra kant.
  const SINK = 4;
  const o = { u0: scr.u0 - 1.6, u1: scr.u1 + 1.6, v0: scr.v0 - 1.6, v1: scr.v1 + 1.6 };
  body.push(
    // Urtagets botten (bakom skärmen), golv och vänstra vägg.
    { d: pathOf(roundedFace(front(SINK), o.u0, o.u1, o.v0, o.v1, R(0.8))), fill: '#05070a' },
    { d: pathOf([project(o.u0, o.v0, 0), project(o.u1, o.v0, 0), project(o.u1, o.v0, SINK), project(o.u0, o.v0, SINK)]), fill: lin('pbRecessFloor', project(0, o.v0, 0), project(0, o.v0, SINK), [[0, '#4a4f56'], [1, '#1d2025']]) },
    { d: pathOf([project(o.u0, o.v0, 0), project(o.u0, o.v1, 0), project(o.u0, o.v1, SINK), project(o.u0, o.v0, SINK)]), fill: lin('pbRecessWall', project(o.u0, 0, 0), project(o.u0, 0, SINK), [[0, '#2c3036'], [1, '#121418']]) },
    { d: pathOf(roundedFace(front(SINK), scr.u0, scr.u1, scr.v0, scr.v1, R(0.5))), fill: '#03060e' },
    // Ramen, ovanpå: en aning glans, ljusare upptill än nedtill och en svag
    // ljus linje i överkanten. Inget mer — ramen ska vara lugn.
    {
      d: pathOf(frameOuter) + pathOf(frameInner),
      evenOdd: true,
      fill: lin('pbFrame', project(0, scr.v1 + 3.2, 0), project(0, scr.v0 - 3.2, 0), [[0, '#9aa0a7'], [0.45, '#7d838a'], [1, '#6c7279']]),
    },
    { d: pathOf([project(scr.u0 - 1.6, scr.v1 + 3.05, 0), project(scr.u1 + 1.6, scr.v1 + 3.05, 0)], false), stroke: '#ffffff', sw: 0.3, opacity: 0.35 },
  );
  // Skärmens yta, där displayens innehåll ritas: i det nedsänkta planet.
  const [sx0, sy1] = project(scr.u0, scr.v1, SINK);
  const [sx1, sy0] = project(scr.u1, scr.v0, SINK);

  // ── Locket, stängt ──
  const L0 = -1, L1 = W + 1, Z0 = -1, Z1 = D + 1, LY = H, LT = H + LID;
  const lidFront = roundedFace(front(Z0), L0, L1, LY, LT, [1, 1, 3, 3]);
  const lidSide = roundedFace(side(L1), Z0, Z1, LY, LT, [1, 1, 2.5, 3]);
  const lidTop = roundedFace(top(LT), L0, L1, Z0, Z1, [8, 8, 8, 8]);
  const lid: Prim[] = [
    { d: pathOf(lidSide), fill: lin('pbLidSide', project(L1, LT, 0), project(L1, LY, D), [[0, '#d8bb92'], [1, '#b18e62']]) },
    ...grain(side(L1), Z0, Z1, LY, LT - 2, 5, 19),
    { d: pathOf(lidTop), fill: lin('pbLidTop', project(0, LT, 0), project(W, LT, D), [[0, '#f0dcbb'], [0.6, '#e4cba5'], [1, '#d4b78e']]) },
    ...grain(top(LT), L0, L1, Z0, Z1, 70, 11),
    { d: pathOf(lidFront), fill: lin('pbLidFront', project(0, LT, Z0), project(0, LY, Z0), [[0, '#ecd7b5'], [0.25, '#dcc199'], [1, '#cfb085']]) },
    ...grain(front(Z0), L0, L1, LY, LT - 2, 12, 23),
    // Den rundade kanten mellan topp och framsida: ett ljust band.
    { d: pathOf(roundedFace(front(Z0), L0 + 3, L1 - 3, LT - 2.5, LT, [0, 0, 2.5, 2.5])), fill: lin('pbBevel', project(0, LT - 2.5, Z0), project(0, LT, Z0), [[0, '#fff6e4', 0], [1, '#fff6e4', 0.5]]) },
    { d: pathOf(roundedFace(top(LT), L0 + 4, L1 - 4, Z0, Z0 + 5, [0, 0, 0, 0])), fill: '#fff8ea', opacity: 0.28 },
    { d: pathOf(roundedFace(side(L1), Z0 + 2, Z1 - 3, LT - 2, LT, [0, 0, 2, 2])), fill: '#fff4dc', opacity: 0.2 },
    // Lockets underkant.
    { d: pathOf([project(L0 + 1, LY, Z0), project(L1, LY, Z0), project(L1, LY, Z1 - 1)], false), stroke: '#5c3f22', sw: 1.1, opacity: 0.5 },
  ];

  return {
    grads,
    shadow,
    interior,
    phone,
    phoneFront,
    tagGlow,
    tag,
    tagCenter: project(tagC.x, tz, tagC.z),
    body,
    lid,
    screen: { x: sx0, y: sy1, w: sx1 - sx0, h: sy0 - sy1 },
    phoneFocus: project(tagC.x, top0 + 0.5, tagC.z),
    phoneCenter: project((P.x0 + P.x1) / 2, top0, (P.z0 + P.z1) / 2),
    phoneLength: P.x1 - P.x0,
    phoneDepth: (P.z1 - P.z0) * KY + P.thick,
  };
}

function ellipsePath(cx: number, cy: number, rx: number, ry: number) {
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
}
