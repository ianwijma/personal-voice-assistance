/**
 * Cloud orb: a soft sphere of light with clouds churning inside, after ChatGPT's Advanced Voice
 * orb, with the ElevenLabs split between the two voices.
 *
 * One fragment shader. Inside the sphere, two layers of fractal noise are projected onto a bulge
 * and zoomed continuously (an endless zoom, cross-faded between two layers), so the clouds stream
 * *inward* toward the centre while the orb takes in your voice and *outward* while it speaks.
 * Your loudness changes the orb's size; the assistant's loudness changes how fast the inside
 * flows. A syllable sends a ring of denser cloud inward (you) or outward (assistant). Pitch sets
 * where the light pools inside, register the grain of the clouds, voicing how defined they are.
 */
import type { Character, CharacterInstance, Rgb, VoiceFeatures } from "../contract.ts"
import { AttackRelease, FULLSCREEN_VERTEX, approach, clamp, clamp01, glProgram, lerp, optChoice, optNumber, optToggle } from "../kit.ts"
import { ChoiceMix, type Col, Glide, hueShift, mixInto, ModeMix, ONSET } from "../shared/light.ts"

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 outColor;
uniform vec2 uCen;        // orb centre, device px, y up (gl_FragCoord's frame)
uniform float uR;         // sphere radius, device px
uniform float uZoom;      // radial flow phase (increasing = inward)
uniform float uChurn;     // slow evolution of the clouds
uniform float uSwirl;     // rotation of the inside, radians
uniform float uTwist;     // spiral twist (lively intonation)
uniform float uDetail;    // noise scale (register)
uniform float uDefine;    // cloud contrast (voicing)
uniform float uDrift;     // vertical drift of the clouds (intonation)
uniform vec2 uLight;      // where the light pools, in sphere radii
uniform float uLightK;    // highlight strength
uniform vec2 uRing;       // onset ring: radius 0..1, strength
uniform float uTwoTone;   // thinking: marble of both colours
uniform float uHalo;      // halo strength
uniform float uDark;      // 1 dark theme, 0 light
uniform float uBands;     // look option: 0 soft clouds .. 1 contour bands
uniform float uSmooth;    // look option: 0 clouds .. 1 smooth glowing orb
uniform vec3 uA;          // shadow tone
uniform vec3 uB;          // body tone
uniform vec3 uC;          // light tone
uniform vec3 uA2;         // second family (thinking)
uniform vec3 uB2;
uniform vec3 uC2;

// Simplex 3D noise (snoise) from https://github.com/ashima/webgl-noise. The upstream notice, kept as the licence requires:
//
// Copyright (C) 2011 by Ashima Arts (Simplex noise)
// Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
vec4 permute(vec4 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0 / 7.0;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float clouds(vec2 q, float ph, float seed) {
  float s = exp2(ph);
  vec3 c = vec3(q * uDetail * s + vec2(seed * 7.3, uDrift), uChurn + seed * 3.1);
  // Two octaves: soft billows with a little detail (4 simplex lookups per pixel for both layers).
  float n = 0.66 * snoise(c);
  n += 0.34 * snoise(c * 2.3 + vec3(1.7, 9.2, 0.0));
  return n;
}

void main() {
  vec2 p = (gl_FragCoord.xy - uCen) / uR;
  float r = length(p);
  float aa = 1.5 / uR;
  // Halo reach: the tight halo dies within ~1.2 radii; the wide haze fades to nothing by 6 radii.
  float reach = uHalo > 0.001 ? 6.0 : 0.0;
  if (r > 1.0 + reach + aa) { outColor = vec4(0.0); return; }
  // Wide, faint haze that spreads over the stage, starting outside the box's usual reach, with a
  // smooth fade to zero at its far end (no edge anywhere).
  float haze = uHalo * 0.1 * exp(-max(r - 1.4, 0.0) * 1.2) * smoothstep(1.1, 1.7, r) * (1.0 - smoothstep(2.0, 6.0, r));
  // A hair of dither so the faint gradient does not band into rings.
  haze = max(haze * (0.85 + 0.3 * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453)), 0.0);

  float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  float z = sqrt(max(0.0, 1.0 - r * r));
  // Bulge projection: the clouds bend around the sphere.
  vec2 q = p / (0.45 + z);
  float tw = uSwirl * (1.2 - 0.6 * r) + uTwist * r * r * 2.5;
  float ca = cos(tw);
  float sa = sin(tw);
  q = mat2(ca, -sa, sa, ca) * q;

  // Endless radial zoom: two layers half a period apart, cross-faded.
  float f1 = fract(uZoom);
  float f2 = fract(uZoom + 0.5);
  float w1 = 1.0 - abs(2.0 * f1 - 1.0);
  float n = 0.0;
  if (inside > 0.0) {
    n = clouds(q, f1, floor(uZoom)) * w1 + clouds(q, f2, floor(uZoom + 0.5) + 0.5) * (1.0 - w1);
  }
  n = n / (0.55 + 0.45 * abs(2.0 * w1 - 1.0)); // keep contrast through the cross-fade
  n *= 1.0 - 0.85 * uSmooth;
  // Onset ring: a band of denser cloud at radius uRing.x.
  float ring = uRing.y * exp(-pow((r - uRing.x) / 0.1, 2.0));
  float dens = clamp(0.5 + n * (0.2 + 0.38 * uDefine) + ring * 0.35, 0.0, 1.0);
  // A whisper (low definition) turns the clouds to an even, paler fog.
  dens = mix(0.42, dens, 0.35 + 0.65 * uDefine);

  // Light pooling inside, and a rim.
  float light = exp(-dot(p - uLight, p - uLight) / 0.32) * uLightK;
  float rim = pow(1.0 - z, 3.0);

  // Soft vertical shading: lighter toward the top, as if lit from above.
  float shade = 0.5 + 0.5 * p.y;
  float d2 = dens * 0.8 + shade * 0.25 + light * 0.45;
  // Contour bands: the density stepped into five soft-edged levels.
  float q5 = d2 * 5.0;
  d2 = mix(d2, (floor(q5) + smoothstep(0.4, 0.6, fract(q5))) / 5.0, uBands);
  vec3 col1 = mix(uA, uB, smoothstep(0.15, 0.7, d2));
  col1 = mix(col1, uC, smoothstep(0.6, 1.15, d2));
  vec3 col2 = mix(uA2, uB2, smoothstep(0.15, 0.7, d2));
  col2 = mix(col2, uC2, smoothstep(0.6, 1.15, d2));
  float marble = smoothstep(-0.7, 0.7, sin(atan(p.y, p.x) * 2.0 + uSwirl * 1.3 + n * 3.0 + r * 2.5));
  vec3 col = mix(col1, col2, uTwoTone * marble);

  float a;
  if (uDark > 0.5) {
    col += uB * rim * 0.45;
    col *= 0.8 + 0.3 * z; // a little depth
    a = inside * (0.82 + 0.18 * dens);
    // Halo: light spilling out around the sphere.
    float halo = uHalo * exp(-(r - 1.0) * 5.0) * (1.0 - inside);
    vec3 hc = mix(uB, uB2, uTwoTone * 0.5);
    halo += haze * (1.0 - inside) / 0.55;
    outColor = vec4(col * a + hc * halo * 0.55, a + halo * 0.55);
  } else {
    // Light theme: a tinted volume, darker at the rim, with a soft coloured shadow outside.
    col = mix(col, uB * 0.82, rim * 0.55);
    a = inside * (0.9 + 0.1 * dens);
    float halo = uHalo * exp(-(r - 1.0) * 6.0) * (1.0 - inside) * 0.35;
    halo += haze * 0.35 * (1.0 - inside);
    outColor = vec4(col * a + uB * halo, a + halo);
  }
}`

/** Reduced motion: levels in quarter steps. */
const quant = (x: number, reduced: boolean): number => (reduced ? Math.round(x * 4) / 4 : x)
const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]
const LOOKS = ["clouds", "bands", "smooth"] as const

const create = (canvas: HTMLCanvasElement): CharacterInstance => {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false })
  if (gl === null) throw new Error("WebGL2 unavailable")
  const prog = glProgram(gl, FULLSCREEN_VERTEX, FRAGMENT)
  const vao = gl.createVertexArray()
  const u = (name: string) => gl.getUniformLocation(prog, name)
  const U = {
    cen: u("uCen"),
    r: u("uR"),
    zoom: u("uZoom"),
    churn: u("uChurn"),
    swirl: u("uSwirl"),
    twist: u("uTwist"),
    detail: u("uDetail"),
    define: u("uDefine"),
    drift: u("uDrift"),
    light: u("uLight"),
    lightK: u("uLightK"),
    ring: u("uRing"),
    twoTone: u("uTwoTone"),
    halo: u("uHalo"),
    dark: u("uDark"),
    bands: u("uBands"),
    smooth: u("uSmooth"),
    a: u("uA"),
    b: u("uB"),
    c: u("uC"),
    a2: u("uA2"),
    b2: u("uB2"),
    c2: u("uC2")
  }
  let W = 1
  let H = 1
  let CH = 1 // the canvas's height, CSS px
  let dpr = 1

  const mix = new ModeMix()
  const userLvl = new AttackRelease(0.05, 0.3)
  const agentLvl = new AttackRelease(0.05, 0.35)
  const size = new AttackRelease(0.09, 0.35)
  let zoom = 0
  let churn = 0
  let swirl = 0
  let drift = 0
  let detail = 0.9
  let define = 0.8
  let lightX = 0
  let lightY = 0.2
  let lightK = 0.6
  let ringR = 0
  let ringS = 0
  let ringDir = 1
  let prevOnset = 0
  let rise = 0
  let lively = 0.3
  let reg = 0.45

  // Options, eased.
  const glide = new Glide()
  const lookMix = new ChoiceMix(LOOKS)
  let sizeK = 1
  let grainK = 1
  let haloK = 1
  let swellK = 1
  let pressK = 1 // the press shrink, eased
  let pitchK = 1
  let clock = -1 // ambient time at the "Motion speed"

  const base: Col = [0, 0, 0]
  const famA: Col = [0, 0, 0]
  const famB: Col = [0, 0, 0]
  const famC: Col = [0, 0, 0]
  const tmp2: Col = [0, 0, 0]
  const tint: Col = [0, 0, 0]

  /** Shadow / body / light tones of one colour for the current theme, as 0..1 uniforms. */
  const tones = (c: Rgb, dark: boolean, bg: Rgb, locA: WebGLUniformLocation | null, locB: WebGLUniformLocation | null, locC: WebGLUniformLocation | null): void => {
    if (dark) {
      // Deep, cooler shadows; the colour itself; a pale, slightly warmer light.
      hueShift(c, 16, tmp2)
      mixInto(famA, tmp2, BLACK, 0.55)
      mixInto(famB, c, BLACK, 0.05)
      hueShift(c, -10, tmp2)
      mixInto(famC, tmp2, WHITE, 0.6)
    } else {
      // On a pale page: a pale tint for the thin parts, the colour for the dense wisps, a pale
      // light where it pools, and a deeper rim (in the shader) so the orb holds its shape.
      hueShift(c, -8, tmp2)
      mixInto(famA, tmp2, bg, 0.6)
      mixInto(famB, c, bg, 0.12)
      hueShift(c, 10, tmp2)
      mixInto(famC, tmp2, WHITE, 0.55)
    }
    gl.uniform3f(locA, famA[0]! / 255, famA[1]! / 255, famA[2]! / 255)
    gl.uniform3f(locB, famB[0]! / 255, famB[1]! / 255, famB[2]! / 255)
    gl.uniform3f(locC, famC[0]! / 255, famC[1]! / 255, famC[2]! / 255)
  }

  return {
    resize(width, height, ratio) {
      CH = height
      dpr = ratio
      gl.viewport(0, 0, Math.round(width * dpr), Math.round(height * dpr))
    },

    frame(f) {
      const dt = f.dt
      const fo = f.focus
      W = fo.width
      H = fo.height
      const p = f.palette
      const reduced = f.reducedMotion
      // Hold the pose: under reduced motion every level jumps to its target (no continuous easing).
      const ease = (cur: number, target: number, dt: number, tau: number): number => (reduced ? target : approach(cur, target, dt, tau))
      mix.step(f, 0.4)

      // Options.
      const o = f.options
      glide.begin(f)
      sizeK = glide.to(sizeK, optNumber(o, "size"))
      grainK = glide.to(grainK, optNumber(o, "grain"), 0.3)
      haloK = glide.to(haloK, optNumber(o, "halo"))
      swellK = glide.to(swellK, optNumber(o, "swell"))
      pitchK = glide.to(pitchK, optNumber(o, "pitch"))
      const look = lookMix.step(glide, optChoice(o, "look"), 0.3)
      const ringsOn = optToggle(o, "rings")
      const speed = optNumber(o, "speed")
      const motion = reduced ? 0 : speed
      clock = clock < 0 ? f.t : clock + dt * speed

      const speaking = f.coreMode === "speaking"
      const hearing = f.coreMode === "hearing"
      const Lu = reduced ? (hearing ? quant(f.user.level, true) : 0) : userLvl.step(hearing ? f.user.level : 0, dt)
      const La = reduced ? (speaking ? quant(f.agent.level, true) : 0) : agentLvl.step(speaking ? f.agent.level : 0, dt)
      const v: VoiceFeatures = speaking ? f.agent : f.user
      const live = hearing || speaking

      // Size: the person's loudness swells the orb; the reply only breathes it slightly.
      const R0 = Math.min(H * 0.36, W * 0.3)
      const press = f.pointer.down && f.pointer.inside && f.pointer.x >= fo.x && f.pointer.x < fo.x + W && f.pointer.y >= fo.y && f.pointer.y < fo.y + H ? 0.95 : 1
      pressK = ease(pressK, press, dt, 0.08)
      const breathe = reduced ? 1 : 1 + 0.025 * Math.sin(clock * 1.6) * mix.listening
      const sT = mix.of(0.62, 0.86, 0.9 + 0.38 * swellK * clamp01(Lu * 1.5), 0.8, 0.86 + 0.3 * swellK * clamp01(La * 1.6)) * breathe
      const s = reduced ? sT : size.step(sT, dt)

      // Flow: inward while taking in (gently, faster when you are louder), outward while speaking
      // at a speed set by the reply's loudness (after ElevenLabs: speed 0.1 + 0.9·(1 − (out − 1)²)).
      const la = clamp01(La * 1.6)
      const outSpeed = 0.1 + 0.9 * (1 - (la - 1) * (la - 1))
      const zoomRate = mix.listening * 0.06 + mix.hearing * (0.08 + 0.3 * clamp01(Lu * 1.5)) - mix.speaking * (0.08 + 0.55 * outSpeed) + mix.idle * 0.01
      zoom += zoomRate * dt * motion
      churn += dt * motion * (0.05 + mix.hearing * 0.05 * (v.syllableRate / 4) + mix.speaking * 0.25 * outSpeed + mix.thinking * 0.12)
      swirl += dt * motion * mix.of(0.03, 0.06, 0.08, 1.5, 0.12)
      if (live && v.speaking) {
        rise = ease(rise, clamp(v.pitchDelta / 10, -1, 1), dt, 0.4)
        lively = ease(lively, clamp01(Math.abs(v.pitchDelta) / 7), dt, 0.8)
        reg = ease(reg, clamp01((v.register - 0.15) / 0.75), dt, 0.8)
        define = ease(define, clamp01(v.voicing * 1.3), dt, 0.3)
        detail = ease(detail, lerp(0.45, 1.9, reg), dt, 0.8)
        // "Follow pitch" scales how far the light travels around the middle of its range.
        const ly = lerp(-0.45, 0.55, reduced ? Math.round(v.pitch * 4) / 4 : v.pitch)
        lightY = ease(lightY, clamp(0.05 + (ly - 0.05) * pitchK, -0.8, 0.8), dt, reduced ? 0.25 : 0.15)
        lightK = ease(lightK, 0.35 + 0.9 * v.brightness + (speaking ? 0.9 * clamp01(La * 1.6) : 0), dt, 0.15)
      } else {
        rise = ease(rise, 0, dt, 0.6)
        define = ease(define, f.coreMode === "idle" ? 0.35 : 0.8, dt, 0.6)
        lightY = ease(lightY, 0.25, dt, 0.8)
        lightK = ease(lightK, mix.of(0.25, 0.55, 0.6, 0.7, 0.6), dt, 0.5)
      }
      drift += rise * dt * 0.6 * motion
      // Pointer: the light inside follows the pointer.
      // The orb (not its fading halo) always fits the focus box, whatever the size and swell.
      // The cap comes first and the press shrink after it, so pressing shows even at the largest settings.
      const R = Math.min(R0 * s * sizeK, 0.48 * Math.min(W, H)) * pressK
      // No drawable orb (first frame before the size envelope has risen, or a degenerate focus box): the
      // shader and the pointer mapping divide by the radius, so clear and stop.
      const drawable = R > 0
      const px = f.pointer.x - fo.x
      const py = f.pointer.y - fo.y
      if (drawable && f.pointer.inside && px >= 0 && px < W && py >= 0 && py < H) {
        lightX = ease(lightX, clamp((f.pointer.x - fo.x - W / 2) / R, -0.7, 0.7), dt, 0.2)
        lightY = ease(lightY, clamp(-(f.pointer.y - fo.y - H / 2) / R, -0.7, 0.7), dt, 0.2)
      } else lightX = ease(lightX, 0, dt, 0.4)

      // Onset rings: in from the rim for you, out from the centre for the assistant.
      const onset = live ? v.onset : 0
      if (!reduced && ringsOn && live && onset > ONSET && prevOnset <= ONSET) {
        ringDir = speaking ? 1 : -1
        ringR = speaking ? 0 : 1
        ringS = 0.5 + 0.5 * clamp01((speaking ? La : Lu) * 1.6)
      }
      prevOnset = onset
      if (!reduced) ringR += ringDir * dt * 1.6 * speed
      ringS = ease(ringS, 0, dt, 0.35)

      // Colours by mode.
      // Register tints the person's mint (sea-blue for deep, spring green for high).
      hueShift(p.you, lerp(24, -22, reg) * (p.dark ? 1 : 0.5), tint)
      mixInto(tint, p.you, tint, mix.hearing)
      mixInto(base, p.inkFaint, tint, clamp01(mix.listening + mix.hearing + mix.thinking))
      mixInto(base, base, p.voice, clamp01(mix.speaking))

      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      if (!drawable) return
      gl.useProgram(prog)
      gl.bindVertexArray(vao)
      gl.uniform2f(U.cen, (fo.x + W / 2) * dpr, (CH - fo.y - H / 2) * dpr)
      gl.uniform1f(U.r, R * dpr)
      gl.uniform1f(U.zoom, zoom)
      gl.uniform1f(U.churn, churn)
      gl.uniform1f(U.swirl, swirl)
      gl.uniform1f(U.twist, (mix.hearing + mix.speaking) * lively * (reduced ? 0.5 : 1))
      gl.uniform1f(U.detail, detail * grainK)
      gl.uniform1f(U.define, define)
      gl.uniform1f(U.drift, drift)
      gl.uniform2f(U.light, lightX, lightY)
      gl.uniform1f(U.lightK, lightK)
      gl.uniform2f(U.ring, ringR, ringS)
      gl.uniform1f(U.twoTone, mix.thinking * 0.85)
      gl.uniform1f(U.halo, mix.of(0.15, 0.55, 0.45 + 0.55 * clamp01(Lu * 1.5), 0.45, 0.2 + 1.2 * la) * haloK)
      gl.uniform1f(U.dark, p.dark ? 1 : 0)
      gl.uniform1f(U.bands, look[1]!)
      gl.uniform1f(U.smooth, look[2]!)
      tones(base, p.dark, p.bg, U.a, U.b, U.c)
      tones(p.voice, p.dark, p.bg, U.a2, U.b2, U.c2)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },

    dispose() {
      gl.deleteProgram(prog)
      gl.deleteVertexArray(vao)
      gl.getExtension("WEBGL_lose_context")?.loseContext()
    }
  }
}

const character: Character = {
  id: "cloud-orb",
  name: "Cloud orb",
  version: "1.1.1",
  contract: 1,
  family: "abstract",
  renderer: "webgl2",
  canvas: "stage",
  summary: "A soft sphere of churning cloud light: your loudness changes its size, the assistant's how fast the inside flows; clouds stream inward while it listens and outward while it speaks.",
  inspiredBy:
    "ChatGPT's Advanced Voice orb (a soft textured sphere with slow inner flow) and the ElevenLabs UI orb's split (input volume to size, output volume to flow speed, its speed curve reused). The inward / outward stream follows Meta AI's ring.",
  modes: {
    idle: "A small, dim grey orb with hazy, nearly still clouds.",
    listening: "A mint orb, a little larger, breathing slowly with a soft halo; its clouds drift gently inward.",
    hearing: "The mint orb swells with your voice; clouds stream toward the centre and each syllable sends a dense ring inward from the rim.",
    thinking: "Mint and amber marble together and swirl around the centre.",
    speaking: "An amber orb at full size; clouds pour outward from the centre, faster the louder the reply, with rings going out on each syllable."
  },
  mappings: [
    { signal: "user.level (hearing)", effect: "Orb size: 0.9 → 1.28× (90 ms rise, 350 ms fall); inward flow speed; halo strength." },
    { signal: "agent.level (speaking)", effect: "Outward flow speed 0.1 + 0.9·(1 − (level·1.6 − 1)²) (the ElevenLabs curve) and churn speed; also, so a still frame shows it, halo reach (0.2 → 1.4), inner light (+0.9) and size (0.86 → 1.16×)." },
    { signal: "active.onset", effect: "A ring of denser cloud: from the rim inward for you, from the centre outward for the assistant, strength from loudness." },
    { signal: "active.pitch", effect: "Where the light pools inside: low in the orb for a low pitch, high for a high one (150 ms)." },
    { signal: "active.register", effect: "Cloud grain: broad billows for a deep voice (noise scale 0.45), fine grain for a child's (1.9); and, while hearing, the mint's hue (sea-blue for deep, spring green for high); 800 ms." },
    { signal: "active.voicing", effect: "Cloud definition: voiced speech gives defined billows, a whisper an even, paler fog." },
    { signal: "|active.pitchDelta| (800 ms)", effect: "Liveliness: expressive intonation twists the clouds into a spiral; flat speech leaves them calm." },
    { signal: "active.brightness", effect: "Strength of the inner light." },
    { signal: "active.pitchDelta", effect: "The clouds drift upward while the voice rises (a question) and downward while it falls." },
    { signal: "active.syllableRate (hearing)", effect: "Churn speed of the clouds while you talk." },
    { signal: "mode", effect: "Colour (grey / mint / mint-and-amber marble / amber), size, flow direction and swirl; 400 ms crossfade." },
    { signal: "pointer", effect: "The inner light follows the pointer; pressing shrinks the orb 5 %." },
    { signal: "options", effect: "Size, size reaction, follow pitch, motion speed, syllable rings, look (clouds / contour bands / smooth), cloud grain and halo change every mode; they glide over 0.2–0.3 s (snap under reduced motion). The orb is capped at 48 % of the short side of the box so it never leaves it." },
    { signal: "reducedMotion", effect: "No flow, churn, swirl, rings or breathing, and no easing: the orb holds its pose, a still orb whose colour, size and marble show the mode; levels in quarter steps, inner light position in quarters." }
  ],
  options: [
    { id: "size", kind: "number", label: "Size", min: 0.5, max: 1.25, step: 0.05, default: 1, unit: "×", group: "Shape", help: "How big the orb is." },
    { id: "swell", kind: "number", label: "Size reaction", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How much the orb grows when someone speaks; 0 keeps it a steady size." },
    { id: "pitch", kind: "number", label: "Follow pitch", min: 0, max: 2, step: 0.1, default: 1, unit: "×", group: "Reaction", help: "How far the light inside moves up and down with the pitch of the voice." },
    { id: "speed", kind: "number", label: "Motion speed", min: 0.2, max: 2, step: 0.05, default: 1, unit: "×", group: "Motion", help: "How fast the clouds flow, churn and swirl; lower is calmer." },
    { id: "rings", kind: "toggle", label: "Syllable rings", default: true, group: "Motion", help: "A ring of denser cloud runs in or out on every syllable." },
    {
      id: "look",
      kind: "choice",
      label: "Look",
      choices: [
        { value: "clouds", label: "Clouds" },
        { value: "bands", label: "Contour bands" },
        { value: "smooth", label: "Smooth" }
      ],
      default: "clouds",
      group: "Style",
      help: "Soft churning clouds, stepped bands like a contour map, or a smooth glowing ball."
    },
    { id: "grain", kind: "number", label: "Cloud grain", min: 0.5, max: 2, step: 0.05, default: 1, unit: "×", group: "Style", help: "Broad billows at the low end, fine grain at the high end." },
    { id: "halo", kind: "number", label: "Halo", min: 0, max: 1.5, step: 0.05, default: 1, unit: "×", group: "Style", help: "How much light spills out around the orb." }
  ],
  create
}

export default character
