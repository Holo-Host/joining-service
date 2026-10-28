// Copied from unytco/unyt-app ui/white-label/src/components/identicon/utils.ts and discs.ts at d547b137, so a key draws the picture the app draws.

type Color = { h: number; s: number; l: number };

const randseed: number[] = new Array(4); // Xorshift: [x, y, z, w] 32 bit values

function seedrand(seed: string): void {
  randseed.fill(0);

  for (let i = 0; i < seed.length; i++) {
    randseed[i % 4] = (randseed[i % 4]! << 5) - randseed[i % 4]! + seed.charCodeAt(i);
  }
}

function rand(): number {
  // based on Java's String.hashCode(), expanded to 4 32bit values
  const t = randseed[0]! ^ (randseed[0]! << 11);

  randseed[0] = randseed[1]!;
  randseed[1] = randseed[2]!;
  randseed[2] = randseed[3]!;
  randseed[3] = randseed[3]! ^ (randseed[3]! >> 19) ^ t ^ (t >> 8);

  return (randseed[3]! >>> 0) / ((1 << 31) >>> 0);
}

function createColor(): Color {
  //saturation is the whole color spectrum
  const h = Math.floor(rand() * 360);
  //saturation goes from 40 to 100, it avoids greyish colors
  const s = rand() * 60 + 40;
  //lightness can be anything from 0 to 100, but probabilities are a bell curve around 50%
  const l = (rand() + rand() + rand() + rand()) * 25;

  return { h, s, l };
}

function encodeColor({ h, s, l }: Color): string {
  return `hsl(${h}, ${s}%, ${l}%)`;
}

interface DiscContext {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  fill(): void;
}

interface DiscCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): DiscContext | null;
}

function renderDiscIcon(opts: { seed: string; size: number }, canvas: DiscCanvas): DiscCanvas {
  const { size } = opts;
  seedrand(opts.seed);

  canvas.width = canvas.height = size;

  const cc = canvas.getContext("2d")!;
  cc.fillStyle = encodeColor({ h: 0, s: 0, l: 100 * rand() });
  cc.fillRect(0, 0, canvas.width, canvas.height);
  const numDiscs = 3 + rand() * 10;
  for (let i = 0; i < numDiscs; i++) {
    cc.fillStyle = encodeColor(createColor());
    cc.beginPath();
    let radius;
    if (i < 2) {
      radius = rand() * size;
    } else {
      radius = rand() * size * 0.125;
    }
    cc.arc(rand() * size, rand() * size, radius, 0, 2 * Math.PI);
    cc.fill();
  }

  return canvas;
}

/** The Unyt app's settings screen draws an agent's identicon on a canvas of this size. */
const SIZE = 120;

/** The agent key's identicon as inline SVG, recording the canvas calls the app makes. Every arc is a whole disc. */
export function identiconSvg(agentKey: string): string {
  const shapes: string[] = [];
  let disc = '';
  const cc: DiscContext = {
    fillStyle: '',
    fillRect(x, y, w, h) {
      shapes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${this.fillStyle}"/>`);
    },
    beginPath() {
      disc = '';
    },
    arc(x, y, radius) {
      disc = `cx="${x}" cy="${y}" r="${radius}"`;
    },
    fill() {
      shapes.push(`<circle ${disc} fill="${this.fillStyle}"/>`);
    },
  };
  renderDiscIcon({ seed: agentKey, size: SIZE }, { width: 0, height: 0, getContext: () => cc });
  return `<svg class="identicon" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="Agent icon">${shapes.join('')}</svg>`;
}
