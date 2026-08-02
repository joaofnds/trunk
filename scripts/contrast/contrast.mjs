// WCAG contrast helper for Trunk's oklch theme. No deps.
//
// Pipeline: oklch -> OKLab -> linear sRGB -> gamma sRGB (8-bit round) -> WCAG luminance.
// Translucent layers are composited "source-over" in gamma sRGB space (how browsers
// actually blend overlapping semi-transparent background-colors and `opacity`).
//
// Resolves any value found in src/app.css: var(--x), oklch(L C H [/ a]),
// color-mix(in oklch, <expr> p%, transparent), color-mix(in oklch, <expr> p%, <expr>),
// rgba()/rgb(), #hex. Tokens are parsed live from app.css so the helper never drifts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as presolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const APP_CSS = presolve(__dir, "../../src/app.css");

// ---------- color space conversions ----------

function oklchToLinearSrgb(L, C, H) {
	const hr = (H * Math.PI) / 180;
	const a = C * Math.cos(hr);
	const b = C * Math.sin(hr);

	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;

	const l = l_ ** 3;
	const m = m_ ** 3;
	const s = s_ ** 3;

	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
	];
}

function linToGamma(x) {
	const c = Math.min(Math.max(x, 0), 1);
	return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function gammaToLin(x) {
	return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

// oklch -> gamma sRGB in 0..1, rounded through 8-bit (faithful to WCAG's 8-bit inputs)
function oklchToSrgb(L, C, H) {
	const [r, g, b] = oklchToLinearSrgb(L, C, H).map(linToGamma);
	return [r, g, b].map((v) => Math.round(v * 255) / 255);
}

// WCAG relative luminance from gamma sRGB 0..1
function luminance([r, g, b]) {
	return 0.2126 * gammaToLin(r) + 0.7152 * gammaToLin(g) + 0.0722 * gammaToLin(b);
}

function ratio(fg, bg) {
	const L1 = luminance(fg);
	const L2 = luminance(bg);
	const [hi, lo] = L1 >= L2 ? [L1, L2] : [L2, L1];
	return (hi + 0.05) / (lo + 0.05);
}

// source-over: top {rgb,a} over opaque bottom {rgb}, in gamma sRGB space
function over(top, bottom) {
	const a = top.a ?? 1;
	return top.rgb.map((c, i) => a * c + (1 - a) * bottom[i]);
}

// ---------- token parsing ----------

function parseTokens() {
	const css = readFileSync(APP_CSS, "utf8");
	const root = css.slice(css.indexOf(":root"));
	const map = {};
	const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
	let m;
	while ((m = re.exec(root))) {
		map[m[1].trim()] = m[2].replace(/\/\*[\s\S]*?\*\//g, "").trim();
	}
	return map;
}

const TOKENS = parseTokens();

// ---------- expression resolver -> {rgb:[r,g,b](0..1 gamma), a} ----------

function splitTopLevel(s) {
	const parts = [];
	let depth = 0;
	let cur = "";
	for (const ch of s) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			parts.push(cur.trim());
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts;
}

const TRANSPARENT = { rgb: [0, 0, 0], a: 0 };

function resolve(expr) {
	expr = expr.trim();

	if (expr === "transparent") return TRANSPARENT;

	if (expr.startsWith("var(")) {
		const inner = expr.slice(4, expr.lastIndexOf(")"));
		const parts = splitTopLevel(inner);
		const name = parts[0].trim();
		if (TOKENS[name] !== undefined) return resolve(TOKENS[name]);
		if (parts[1] !== undefined) return resolve(parts[1]); // var fallback
		throw new Error(`unknown token ${name}`);
	}

	if (expr.startsWith("oklch(")) {
		let inner = expr.slice(6, expr.lastIndexOf(")")).trim();
		let a = 1;
		if (inner.includes("/")) {
			const [c, alpha] = inner.split("/");
			inner = c.trim();
			a = parseAlpha(alpha.trim());
		}
		const [L, C, H] = inner.split(/\s+/).map(Number);
		return { rgb: oklchToSrgb(L, C, H), a };
	}

	if (expr.startsWith("color-mix(")) {
		const inner = expr.slice(10, expr.lastIndexOf(")"));
		const parts = splitTopLevel(inner);
		// parts[0] = "in oklch" (interp space), parts[1] = "C p%", parts[2] = "D [q%]"
		const [c1, p1] = parsePctColor(parts[1]);
		const [c2, p2] = parsePctColor(parts[2]);
		let w1 = p1 ?? (p2 != null ? 100 - p2 : 50);
		let w2 = p2 ?? 100 - w1;
		const sum = w1 + w2 || 100;
		w1 /= sum;
		w2 /= sum;
		const A = resolve(c1);
		const B = resolve(c2);
		// premultiplied alpha mix (matches CSS color-mix), then un-premultiply
		const a = w1 * A.a + w2 * B.a;
		if (a === 0) return TRANSPARENT;
		const rgb = [0, 1, 2].map(
			(i) => (w1 * A.a * A.rgb[i] + w2 * B.a * B.rgb[i]) / a,
		);
		return { rgb, a };
	}

	if (expr.startsWith("rgba(") || expr.startsWith("rgb(")) {
		const inner = expr.slice(expr.indexOf("(") + 1, expr.lastIndexOf(")"));
		const nums = inner.split(/[,/]/).map((s) => s.trim());
		const rgb = nums.slice(0, 3).map((n) => Number(n) / 255);
		const a = nums[3] != null ? parseAlpha(nums[3]) : 1;
		return { rgb, a };
	}

	if (expr.startsWith("#")) {
		const h = expr.slice(1);
		const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
		const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
		return { rgb, a: 1 };
	}

	throw new Error(`cannot resolve: ${expr}`);
}

function parseAlpha(s) {
	s = s.trim();
	return s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s);
}

function parsePctColor(s) {
	const mm = s.match(/(.*?)\s+(\d+(?:\.\d+)?)%\s*$/);
	if (mm) return [mm[1].trim(), Number(mm[2])];
	return [s.trim(), null];
}

// ---------- public API ----------

// Composite a foreground over a stack of layers ending at an opaque base.
// layers: array of exprs painted bottom..top (first is nearest the base).
// base: an opaque expr. Returns opaque gamma-sRGB triple.
export function compose(base, layers = []) {
	let bg = resolve(base).rgb;
	for (const layer of layers) bg = over(resolve(layer), bg);
	return bg;
}

// Effective text color after `opacity` o composites the glyph onto its backdrop.
export function withOpacity(fgExpr, o, bgTriple) {
	const fg = resolve(fgExpr).rgb;
	return [0, 1, 2].map((i) => o * fg[i] + (1 - o) * bgTriple[i]);
}

// Contrast of a foreground expr against an opaque composited background.
// opts: { layers:[...] over base, opacity:Number on the text }
export function contrast(fgExpr, baseExpr, opts = {}) {
	const bg = compose(baseExpr, opts.layers || []);
	const fg = opts.opacity != null ? withOpacity(fgExpr, opts.opacity, bg) : resolve(fgExpr).rgb;
	return ratio(fg, bg);
}

export function verdict(r, { large = false } = {}) {
	const aaa = large ? 4.5 : 7;
	const aa = large ? 3 : 4.5;
	if (r >= aaa) return "AAA";
	if (r >= aa) return "AA";
	return "FAIL";
}

export { resolve, ratio, luminance, TOKENS, oklchToSrgb };

// ---------- CLI: node contrast.mjs <fg> <base> [layer...] ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === presolve(process.argv[1])) {
	const [, , fg, base, ...layers] = process.argv;
	if (!fg || !base) {
		console.log("usage: node contrast.mjs '<fg-expr>' '<base-expr>' ['<layer>'...]");
		process.exit(1);
	}
	const r = contrast(fg, base, { layers });
	console.log(`${r.toFixed(2)}:1  ${verdict(r)}   fg=${fg}  base=${base}  layers=[${layers.join(", ")}]`);
}
