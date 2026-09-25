'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DEMO_PHONE_DISPLAY, DEMO_PHONE_E164 } from '../lib/constants';

const LANDING_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background: #090E1A;
  color: #e8e8e8;
  font-family: var(--font-dm-sans), sans-serif;
  font-size: 16px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}

:root {
  --bg: #090E1A;
  --bg2: #0D1525;
  --bg3: #111C30;
  --bg4: #0F1A2E;
  --blue: #2563EB;
  --blue-lt: #60A5FA;
  --blue-dim: rgba(37,99,235,0.12);
  --blue-glow: rgba(37,99,235,0.25);
  --text: #E8F0FF;
  --text-muted: #7A90B8;
  --text-dim: #3A4E6E;
  --border: rgba(37,99,235,0.18);
  --border-md: rgba(255,255,255,0.11);
  --green: #34D399;
  --red: #F87171;
  --amber: #F59E0B;
  --ff-display: var(--font-bebas-neue), sans-serif;
  --ff-body: var(--font-dm-sans), sans-serif;
  --ff-mono: var(--font-jetbrains-mono), monospace;
}

.grid-bg {
  position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background-image:
    linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px);
  background-size: 80px 80px;
  mask-image: radial-gradient(ellipse 90% 60% at 50% 0%, black 0%, transparent 100%);
}

/* ── ANNOUNCE BAR + NAV (single fixed wrapper so the page never has to
   guess the combined height — see .top-fixed) ── */
.top-fixed {
  position: fixed; top: 0; left: 0; right: 0; z-index: 100;
}
.announce-bar {
  display: flex; align-items: center; justify-content: center;
  gap: 8px; flex-wrap: wrap;
  background: var(--amber);
  border-bottom: 2px solid #b45309;
  color: #1a1200;
  font-size: 14px; font-weight: 600; line-height: 1.4;
  padding: 10px 16px; text-align: center;
}
.announce-bar strong { color: #1a1200; font-weight: 800; }
nav {
  height: 64px;
  display: flex; align-items: center; padding: 0 48px;
  background: rgba(8,8,8,0.85);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border);
}
.nav-logo {
  display: flex; align-items: center; gap: 10px;
  font-family: var(--ff-display); font-size: 22px; letter-spacing: 1px;
  color: var(--text); text-decoration: none;
}
.nav-logo-icon {
  width: 34px; height: 34px; background: var(--blue);
  border-radius: 8px; display: flex; align-items: center; justify-content: center;
}
.nav-logo-icon svg { width: 18px; height: 18px; stroke: #fff; fill: none; stroke-width: 2; stroke-linecap: round; }
.nav-links {
  display: flex; gap: 32px; margin-left: auto; margin-right: 40px;
  list-style: none;
}
.nav-links a {
  color: var(--text-dim); text-decoration: none; font-size: 14px;
  transition: color 0.2s;
}
.nav-links a:hover { color: var(--text); }
.nav-cta { display: flex; align-items: center; gap: 10px; }
.nav-phone {
  display: flex; align-items: center;
  font-family: var(--ff-mono); font-size: 13px; color: var(--blue-lt);
  text-decoration: none; padding: 6px 12px;
  border: 1px solid rgba(96,165,250,0.25); border-radius: 6px;
  transition: border-color 0.2s, color 0.2s;
}
.nav-phone:hover { border-color: var(--blue-lt); color: #fff; }
@media (max-width: 768px) { .nav-phone { display: none; } }
.btn-ghost {
  padding: 8px 18px; border: 1px solid var(--border-md);
  background: transparent; color: var(--text-muted);
  border-radius: 8px; font-family: var(--ff-body); font-size: 14px;
  cursor: pointer; transition: all 0.2s; text-decoration: none;
}
.btn-ghost:hover { border-color: rgba(255,255,255,0.22); color: var(--text); }
.btn-login {
  padding: 8px 18px; border: 1px solid var(--border-md);
  background: transparent; color: var(--text);
  border-radius: 8px; font-family: var(--ff-body); font-size: 14px; font-weight: 500;
  cursor: pointer; transition: all 0.2s; text-decoration: none;
}
.btn-login:hover { border-color: rgba(255,255,255,0.22); background: rgba(255,255,255,0.06); }
.btn-primary {
  padding: 9px 20px; background: var(--blue);
  border: none; border-radius: 8px; color: #fff;
  font-family: var(--ff-body); font-size: 14px; font-weight: 500;
  cursor: pointer; transition: all 0.2s; text-decoration: none;
  display: inline-flex; align-items: center; gap: 6px;
}
.btn-primary:hover { background: var(--blue-lt); transform: translateY(-1px); }

/* ── HERO ── */
.hero {
  min-height: 100vh; display: flex; align-items: center;
  padding: 168px 48px 80px; position: relative; z-index: 1;
}
.hero-inner {
  max-width: 1200px; margin: 0 auto; width: 100%;
  display: grid; grid-template-columns: 1fr 1fr; gap: 80px; align-items: center;
}
.hero-eyebrow {
  display: inline-flex; align-items: center; gap: 8px;
  background: var(--blue-dim); border: 1px solid rgba(59,130,246,0.25);
  border-radius: 20px; padding: 5px 14px;
  font-size: 11px; font-weight: 600; color: var(--blue-lt);
  letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 24px;
}
.hero-eyebrow-dot {
  width: 6px; height: 6px; background: var(--blue-lt);
  border-radius: 50%; animation: pulse-dot 2s ease-in-out infinite;
}
@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.75); }
}
.hero-h1 {
  font-family: var(--ff-display);
  font-size: clamp(64px, 7vw, 100px);
  line-height: 0.95; letter-spacing: 1px; color: #fff; margin-bottom: 10px;
}
.hero-h1 .accent { color: rgba(255,255,255,0.08); -webkit-text-stroke: 2px rgba(255,255,255,0.55); }
.hero-h1 .blue { color: var(--blue-lt); }
.hero-sub {
  font-size: 18px; font-weight: 300; color: #999;
  line-height: 1.65; margin-bottom: 40px; max-width: 460px;
}
.hero-sub strong { color: var(--text); font-weight: 500; }
.hero-actions { display: flex; align-items: center; gap: 16px; margin-bottom: 48px; }
.btn-hero {
  padding: 14px 28px; background: var(--blue);
  border: none; border-radius: 10px; color: #fff;
  font-family: var(--ff-body); font-size: 15px; font-weight: 600;
  cursor: pointer; transition: all 0.2s; text-decoration: none;
  display: inline-flex; align-items: center; gap: 8px;
  box-shadow: 0 0 40px rgba(37,99,235,0.35);
}
.btn-hero:hover { background: var(--blue-lt); transform: translateY(-2px); box-shadow: 0 0 60px rgba(59,130,246,0.45); }
.btn-hero svg { width: 16px; height: 16px; stroke: #fff; fill: none; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.hero-link {
  color: var(--text); font-size: 14px; text-decoration: none;
  display: inline-flex; align-items: center; gap: 8px; transition: all 0.2s;
  padding: 12px 22px; border: 1px solid var(--border-md); border-radius: 10px;
}
.hero-link:hover { border-color: rgba(255,255,255,0.22); background: rgba(255,255,255,0.04); }
.hero-stats {
  display: flex; gap: 32px;
  border-top: 1px solid var(--border); padding-top: 32px;
}
.hero-stat-n {
  font-family: var(--ff-display); font-size: 36px; color: #fff; letter-spacing: 0.5px; line-height: 1;
}
.hero-stat-n span { color: var(--blue-lt); }
.hero-stat-l { font-size: 12px; color: var(--text-muted); margin-top: 4px; }

/* ── FEATURE GRID (hero right) ── */
.feat-grid-hero {
  display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
}
.feat-tile {
  background: var(--bg3); border: 1px solid var(--border);
  border-radius: 14px; padding: 24px 20px;
  transition: all 0.25s; position: relative; overflow: hidden;
}
.feat-tile::before {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(135deg, var(--blue-dim) 0%, transparent 60%);
  opacity: 0; transition: opacity 0.3s;
}
.feat-tile:hover { border-color: rgba(59,130,246,0.3); transform: translateY(-2px); }
.feat-tile:hover::before { opacity: 1; }
.feat-tile-icon {
  width: 38px; height: 38px; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 14px; position: relative; z-index: 1;
}
.feat-tile-icon svg { width: 18px; height: 18px; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.feat-tile-icon.blue { background: var(--blue-dim); border: 1px solid rgba(59,130,246,0.2); }
.feat-tile-icon.blue svg { stroke: var(--blue-lt); }
.feat-tile-icon.green { background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2); }
.feat-tile-icon.green svg { stroke: var(--green); }
.feat-tile-icon.amber { background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.2); }
.feat-tile-icon.amber svg { stroke: var(--amber); }
.feat-tile-icon.purple { background: rgba(167,139,250,0.1); border: 1px solid rgba(167,139,250,0.2); }
.feat-tile-icon.purple svg { stroke: #a78bfa; }
.feat-tile-h {
  font-family: var(--ff-display); font-size: 18px; letter-spacing: 0.3px;
  color: #fff; margin-bottom: 6px; position: relative; z-index: 1;
}
.feat-tile-p { font-size: 12px; font-weight: 300; color: #777; line-height: 1.6; position: relative; z-index: 1; }

/* ── LOGO BAR ── */
.logo-bar {
  position: relative; z-index: 1;
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
  padding: 28px 48px;
}
.logo-bar-inner {
  max-width: 1200px; margin: 0 auto;
  display: flex; align-items: center; gap: 48px;
}
.logo-bar-label {
  font-size: 11px; font-weight: 600; color: var(--text-dim);
  letter-spacing: 1.5px; text-transform: uppercase; white-space: nowrap;
}
.logo-bar-items { display: flex; align-items: center; gap: 40px; flex-wrap: wrap; }
.logo-bar-item {
  font-family: var(--ff-display); font-size: 18px; letter-spacing: 1px;
  color: var(--text-dim); white-space: nowrap; transition: color 0.2s;
}
.logo-bar-item:hover { color: var(--text-muted); }

/* ── PROBLEM SECTION ── */
.section { padding: 100px 48px; position: relative; z-index: 1; }
.section-inner { max-width: 1200px; margin: 0 auto; }
.section-eyebrow {
  font-size: 11px; font-weight: 600; color: var(--blue-lt);
  letter-spacing: 2px; text-transform: uppercase; margin-bottom: 16px;
}
.section-h2 {
  font-family: var(--ff-display);
  font-size: clamp(44px, 5vw, 68px);
  line-height: 0.95; letter-spacing: 0.5px; color: #fff; margin-bottom: 16px;
}
.section-sub {
  font-size: 17px; font-weight: 300; color: #888;
  max-width: 520px; line-height: 1.65; margin-bottom: 64px;
}
.problem-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 80px; align-items: center;
}
.problem-points { display: flex; flex-direction: column; gap: 20px; }
.problem-point { display: flex; align-items: flex-start; gap: 14px; }
.problem-dot {
  width: 8px; height: 8px; background: var(--red);
  border-radius: 50%; margin-top: 7px; flex-shrink: 0;
}
.problem-point p { font-size: 15px; color: #999; line-height: 1.6; }
.problem-point strong { color: #e8e8e8; }
.problem-card {
  background: var(--bg3); border: 1px solid var(--border);
  border-radius: 20px; padding: 48px 40px; position: relative; overflow: hidden;
}
.problem-card-bar {
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: linear-gradient(90deg, var(--red), var(--amber));
}
.problem-card-eyebrow {
  font-family: var(--ff-display); font-size: 13px; letter-spacing: 2px;
  color: var(--text-muted); margin-bottom: 12px;
}
.problem-card-stat {
  font-family: var(--ff-display); font-size: 80px; line-height: 0.9;
  color: #fff; letter-spacing: -2px; margin-bottom: 8px;
}
.problem-card-sub { font-size: 15px; color: #888; margin-bottom: 40px; font-weight: 300; line-height: 1.5; }
.problem-card-divider { height: 1px; background: var(--border); margin-bottom: 32px; }
.problem-card-row { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.problem-card-row-item {}
.problem-card-row-num { font-family: var(--ff-display); font-size: 42px; letter-spacing: -1px; }
.problem-card-row-num.amber { color: var(--amber); }
.problem-card-row-num.green { color: var(--green); }
.problem-card-row-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; line-height: 1.5; }
.problem-math {
  margin-top: 24px; padding: 14px 16px;
  background: rgba(34,197,94,0.08); border: 1px solid rgba(34,197,94,0.18); border-radius: 10px;
}
.problem-math-title { font-size: 13px; color: var(--green); font-weight: 500; margin-bottom: 4px; }
.problem-math-body { font-size: 12px; color: #888; line-height: 1.6; }

/* ── HOW IT WORKS ── */
.steps {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 2px; background: var(--border);
  border: 1px solid var(--border); border-radius: 16px; overflow: hidden;
}
.step {
  background: var(--bg2); padding: 40px 36px;
  position: relative; transition: background 0.2s;
}
.step:hover { background: var(--bg3); }
.step-num {
  font-family: var(--ff-display); font-size: 72px; line-height: 1;
  color: rgba(255,255,255,0.04); position: absolute; top: 20px; right: 24px;
  pointer-events: none;
}
.step-icon {
  width: 44px; height: 44px; border-radius: 10px;
  background: var(--blue-dim); border: 1px solid rgba(59,130,246,0.2);
  display: flex; align-items: center; justify-content: center; margin-bottom: 24px;
}
.step-icon svg { width: 20px; height: 20px; stroke: var(--blue-lt); fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.step-h { font-family: var(--ff-display); font-size: 26px; letter-spacing: 0.3px; color: #fff; margin-bottom: 12px; }
.step-p { font-size: 14px; font-weight: 300; color: #888; line-height: 1.65; }

/* ── FEATURES (full width grid) ── */
.features-bg { background: var(--bg2); }
.features-grid {
  display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px;
}
.feat-card {
  background: var(--bg3); border: 1px solid var(--border);
  border-radius: 14px; padding: 32px;
  transition: all 0.25s; cursor: default; position: relative; overflow: hidden;
}
.feat-card::before {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(135deg, var(--blue-dim) 0%, transparent 60%);
  opacity: 0; transition: opacity 0.3s;
}
.feat-card:hover { border-color: rgba(59,130,246,0.25); transform: translateY(-2px); }
.feat-card:hover::before { opacity: 1; }
.feat-card.wide { grid-column: 1 / -1; }
/* Capability grid — expandable "everything it does" tiles (2026-07) */
.cap-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 36px; align-items: stretch; }
.cap-tile { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; text-align: left; width: 100%; min-height: 224px; padding: 22px; border: 1px solid var(--border); border-radius: 16px; background: var(--bg4); color: var(--text); cursor: pointer; font: inherit; transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease; }
.cap-tile:hover { border-color: rgba(37,99,235,0.4); transform: translateY(-2px); }
.cap-tile:focus-visible { outline: 2px solid var(--blue-lt); outline-offset: 2px; }
.cap-tile[aria-expanded="true"] { border-color: var(--blue); box-shadow: 0 0 0 1px var(--blue), 0 8px 24px var(--blue-glow); }
.cap-ic { font-size: 26px; line-height: 1; }
.cap-title { font-size: 17px; font-weight: 700; color: var(--text); }
.cap-hook { font-size: 14px; font-weight: 300; color: var(--text-muted); line-height: 1.55; }
.cap-more { margin-top: auto; padding-top: 6px; font-size: 13px; font-weight: 600; color: var(--blue-lt); display: inline-flex; align-items: center; gap: 6px; }
.cap-caret { display: inline-block; transition: transform .2s ease; }
.cap-tile[aria-expanded="true"] .cap-caret { transform: rotate(180deg); }
.cap-badge { align-self: flex-start; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 3px 8px; border-radius: 999px; background: var(--blue-dim); color: var(--blue-lt); }
.cap-panel { grid-column: 1 / -1; border: 1px solid var(--blue); border-radius: 16px; padding: 22px 24px; background: linear-gradient(180deg, var(--bg3), var(--bg4)); }
.cap-panel[hidden] { display: none; }
.cap-panel.open { animation: capIn .22s ease; }
.cap-panel-h { font-size: 15px; font-weight: 700; color: var(--text); margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.cap-panel .val-layers { margin-top: 0; }
.cap-panel .val-layer { font-size: 13px; color: var(--text-muted); }
@keyframes capIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
@media (max-width: 900px) { .cap-grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 600px) { .cap-grid { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .cap-tile, .cap-caret { transition: none; } .cap-panel.open { animation: none; } }
.feat-icon {
  width: 40px; height: 40px; border-radius: 9px;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 20px; position: relative; z-index: 1;
}
.feat-icon svg { width: 20px; height: 20px; stroke: currentColor; fill: none; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; }
.feat-icon.blue { background: var(--blue-dim); color: var(--blue-lt); border: 1px solid rgba(59,130,246,0.2); }
.feat-icon.green { background: rgba(34,197,94,0.1); color: var(--green); border: 1px solid rgba(34,197,94,0.2); }
.feat-icon.amber { background: rgba(245,158,11,0.1); color: var(--amber); border: 1px solid rgba(245,158,11,0.2); }
.feat-icon.purple { background: rgba(167,139,250,0.1); color: #a78bfa; border: 1px solid rgba(167,139,250,0.2); }
.feat-h {
  font-family: var(--ff-display); font-size: 24px; letter-spacing: 0.3px;
  color: #fff; margin-bottom: 10px; position: relative; z-index: 1;
}
.feat-p { font-size: 14px; font-weight: 300; color: #777; line-height: 1.7; position: relative; z-index: 1; }
.feat-tag {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; font-weight: 600; letter-spacing: 1px;
  text-transform: uppercase; padding: 3px 8px; border-radius: 4px;
  margin-top: 16px; position: relative; z-index: 1;
}
.feat-tag.blue { background: var(--blue-dim); color: var(--blue-lt); }
.feat-tag.green { background: rgba(34,197,94,0.1); color: var(--green); }

/* validation layers widget */
.val-layers { display: flex; flex-direction: column; gap: 6px; margin-top: 20px; position: relative; z-index: 1; }
.val-layer {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 12px; border-radius: 7px;
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06);
  font-size: 12px; color: #999;
}
.val-layer-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.val-layer-dot.green { background: var(--green); }
.val-layer-dot.blue { background: var(--blue-lt); }

/* ── PRICING ── */
.pricing-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;
}
.price-card {
  background: var(--bg3); border: 1px solid var(--border);
  border-radius: 16px; padding: 36px 32px;
  position: relative; transition: all 0.2s;
}
.price-card:hover { border-color: var(--border-md); transform: translateY(-2px); }
.price-card.featured {
  border-color: rgba(59,130,246,0.4);
  background: linear-gradient(180deg, rgba(37,99,235,0.08) 0%, var(--bg3) 100%);
}
.price-card.featured::before {
  content: 'MOST POPULAR';
  position: absolute; top: -1px; left: 50%; transform: translateX(-50%);
  background: var(--blue); color: #fff;
  font-family: var(--ff-display); font-size: 11px; letter-spacing: 1.5px;
  padding: 4px 16px; border-radius: 0 0 8px 8px;
}
.price-name {
  font-family: var(--ff-display); font-size: 20px; letter-spacing: 0.5px;
  color: var(--text-muted); margin-bottom: 16px;
}
.price-amount { display: flex; align-items: baseline; gap: 4px; margin-bottom: 6px; }
.price-dollar { font-size: 22px; font-weight: 400; color: #888; margin-top: 4px; }
.price-num { font-family: var(--ff-display); font-size: 60px; line-height: 1; color: #fff; letter-spacing: -1px; }
.price-period { font-size: 14px; color: var(--text-muted); }
.price-desc { font-size: 13px; color: #666; margin-bottom: 28px; min-height: 36px; line-height: 1.55; }
.price-divider { border: none; border-top: 1px solid var(--border); margin-bottom: 24px; }
.price-features { list-style: none; display: flex; flex-direction: column; gap: 12px; margin-bottom: 32px; }
.price-features li { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: #999; line-height: 1.4; }
.price-features li .check {
  width: 16px; height: 16px; border-radius: 50%;
  background: rgba(34,197,94,0.12); border: 1px solid rgba(34,197,94,0.25);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; margin-top: 1px;
}
.price-features li .check svg { width: 9px; height: 9px; stroke: var(--green); fill: none; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.price-btn {
  width: 100%; padding: 12px; border-radius: 10px;
  font-family: var(--ff-body); font-size: 14px; font-weight: 600;
  cursor: pointer; transition: all 0.2s; text-align: center;
  display: block; text-decoration: none;
}
.price-btn.outline { background: transparent; border: 1px solid var(--border-md); color: var(--text-muted); }
.price-btn.outline:hover { border-color: rgba(255,255,255,0.22); color: var(--text); }
.price-btn.filled { background: var(--blue); border: 1px solid transparent; color: #fff; box-shadow: 0 0 30px rgba(37,99,235,0.3); }
.price-btn.filled:hover { background: var(--blue-lt); box-shadow: 0 0 50px rgba(59,130,246,0.4); }
.trial-note { text-align: center; font-size: 13px; color: var(--text-muted); margin-top: 24px; }
.trial-note span { color: var(--text); font-weight: 500; }

/* ── INDUSTRIES ── */
.biz-grid { display: flex; gap: 10px; flex-wrap: wrap; }
.biz-chip {
  padding: 7px 14px; border: 1px solid var(--border);
  border-radius: 24px; font-size: 13px; color: var(--text-muted);
  background: var(--bg3); transition: all 0.2s; cursor: default;
}
.biz-chip:hover { border-color: var(--border-md); color: var(--text); }

/* ── CTA BAND ── */
.cta-band {
  position: relative; z-index: 1;
  padding: 100px 48px;
  border-top: 1px solid var(--border);
  text-align: center;
  background: radial-gradient(ellipse 60% 80% at 50% 100%, rgba(37,99,235,0.1) 0%, transparent 70%);
}
.cta-band-h {
  font-family: var(--ff-display);
  font-size: clamp(52px, 6vw, 88px);
  line-height: 0.95; letter-spacing: 0.5px; color: #fff; margin-bottom: 20px;
}
.cta-band-sub {
  font-size: 17px; font-weight: 300; color: #888;
  margin-bottom: 44px; max-width: 460px; margin-left: auto; margin-right: auto;
  line-height: 1.65;
}
.cta-band-actions { display: flex; align-items: center; justify-content: center; gap: 16px; }
.cta-number {
  display: inline-flex; align-items: center; gap: 10px;
  background: var(--bg4); border: 1px solid var(--border-md);
  border-radius: 10px; padding: 14px 24px;
  font-family: var(--ff-mono); font-size: 16px; color: var(--text);
}
.cta-number-label { font-family: var(--ff-body); font-size: 11px; color: var(--text-muted); font-family: var(--ff-mono); }

/* ── FOOTER ── */
footer {
  position: relative; z-index: 1;
  border-top: 1px solid var(--border); padding: 36px 48px;
  display: flex; align-items: center; justify-content: space-between;
}
.footer-logo { font-family: var(--ff-display); font-size: 18px; letter-spacing: 0.5px; color: var(--text-muted); }
.footer-copy { font-size: 12px; color: var(--text-dim); }
.footer-links { display: flex; gap: 24px; }
.footer-links a { font-size: 12px; color: var(--text-dim); text-decoration: none; transition: color 0.2s; }
.footer-links a:hover { color: var(--text-muted); }

/* ── ANIMATIONS ── */
.reveal { opacity: 0; transform: translateY(24px); transition: opacity 0.7s ease, transform 0.7s ease; }
.reveal.visible { opacity: 1; transform: translateY(0); }
.reveal-delay-1 { transition-delay: 0.1s; }
.reveal-delay-2 { transition-delay: 0.2s; }
.reveal-delay-3 { transition-delay: 0.3s; }

::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: #222; border-radius: 3px; }

/* ── HAMBURGER ── */
.hamburger {
  display: none; flex-direction: column; justify-content: center;
  gap: 5px;
  /* 44px minimum touch target — iOS HIG / WCAG 2.5.5 */
  width: 44px; height: 44px; cursor: pointer;
  background: transparent; border: none; padding: 8px;
  border-radius: 8px; transition: background 0.2s; margin-left: 8px;
  /* Prevents accidental text selection on double-tap on iPad */
  -webkit-user-select: none; user-select: none;
  touch-action: manipulation;
}
.hamburger:hover, .hamburger:focus-visible { background: rgba(255,255,255,0.08); outline: none; }
.hamburger span {
  display: block; height: 2px; border-radius: 2px;
  background: var(--text); transition: all 0.25s;
}
/* Backdrop — lets iPad users dismiss by tapping outside */
.nav-mobile-backdrop {
  display: none; position: fixed; inset: 0; z-index: 98;
  background: transparent;
}
.nav-mobile-backdrop.open { display: block; }
.nav-mobile-menu {
  display: none; flex-direction: column;
  /* Sits above backdrop (z-98) but below nav (z-100). --top-offset is
     measured from the real .top-fixed height (announce bar + nav) by a
     ResizeObserver in LandingPage — the bar can wrap to 2 lines on
     narrow screens, so a hardcoded guess here would overlap it. 104px
     is only the pre-JS/no-JS fallback. */
  position: fixed; top: var(--top-offset, 104px); left: 0; right: 0; z-index: 99;
  background: rgba(8,8,8,0.97); backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-top: 1px solid var(--border);
  padding: 16px 24px 32px; gap: 0;
  /* iOS Safari scroll isolation — prevents underlying page from
     scrolling through the open menu on iPad */
  overscroll-behavior: contain;
  max-height: calc(100vh - var(--top-offset, 104px));
  overflow-y: auto;
}
.nav-mobile-menu.open { display: flex; }
/* Larger tap targets (44px min height) on each nav link */
.nav-mobile-menu a {
  padding: 14px 0; color: var(--text-muted); text-decoration: none;
  font-size: 16px; border-bottom: 1px solid var(--border);
  transition: color 0.2s; min-height: 44px; display: flex; align-items: center;
}
.nav-mobile-menu a:last-child { border-bottom: none; }
.nav-mobile-menu a:hover, .nav-mobile-menu a:active { color: var(--text); }
.nav-mobile-cta {
  display: flex; gap: 10px; padding-top: 20px; flex-wrap: wrap;
}
.nav-mobile-cta a { min-height: 44px; display: inline-flex; align-items: center; }

@media (max-width: 900px) {
  nav { padding: 0 24px; }
  .nav-links { display: none; }
  .hamburger { display: flex; }
  .announce-bar { font-size: 12px; padding: 8px 12px; }
  .hero { padding: 148px 24px 60px; }
  .hero-inner { grid-template-columns: 1fr; gap: 48px; }
  .feat-grid-hero { grid-template-columns: 1fr 1fr; }
  .section { padding: 72px 24px; }
  .steps { grid-template-columns: 1fr; }
  .features-grid { grid-template-columns: 1fr; }
  .feat-card.wide { grid-column: 1; }
  .pricing-grid { grid-template-columns: 1fr; }
  .cta-band { padding: 72px 24px; }
  footer { flex-direction: column; gap: 16px; text-align: center; padding: 24px; }
  .logo-bar { padding: 24px; }
  .logo-bar-inner { flex-direction: column; gap: 16px; align-items: flex-start; }
  .problem-grid { grid-template-columns: 1fr; gap: 48px; }
}
`;

const LANDING_HTML = `
<div class="grid-bg"></div>

<!-- ANNOUNCE BAR + NAV -->
<div class="top-fixed">
<div class="announce-bar" role="status">
  🚧 <strong>SecretaryHQ is finishing final testing before public launch.</strong> Coming very soon.
</div>
<nav id="main-nav">
  <a href="#" class="nav-logo">
    <div class="nav-logo-icon">
      <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014 12.5a19.8 19.8 0 01-3-8.61A2 2 0 013 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L7.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>
    </div>
    SECRETARY HQ
  </a>
  <ul class="nav-links">
    <li><a href="#how">How It Works</a></li>
    <li><a href="#features">Features</a></li>
    <li><a href="#pricing">Pricing</a></li>
    <li><a href="#industries">Industries</a></li>
  </ul>
  <div class="nav-cta">
    <a href="tel:${DEMO_PHONE_E164}" class="nav-phone" aria-label="Call our demo line">
      <svg viewBox="0 0 24 24" style="width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;vertical-align:middle;margin-right:5px"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014 12.5a19.8 19.8 0 01-3-8.61A2 2 0 013 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L7.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>${DEMO_PHONE_DISPLAY}
    </a>
    <a href="/dashboard" class="btn-login">Log in</a>
    <a href="/register" class="btn-primary">Start free trial</a>
    <button class="hamburger" id="hamburger-btn" aria-label="Open menu" aria-expanded="false" aria-controls="mobile-menu">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>
</div>
<div class="nav-mobile-backdrop" id="mobile-backdrop" aria-hidden="true"></div>
<div class="nav-mobile-menu" id="mobile-menu" role="navigation" aria-label="Mobile navigation">
  <a href="#how">How It Works</a>
  <a href="#features">Features</a>
  <a href="#pricing">Pricing</a>
  <a href="#industries">Industries</a>
  <div class="nav-mobile-cta">
    <a href="tel:${DEMO_PHONE_E164}" style="font-family:var(--ff-mono);font-size:14px;color:var(--blue-lt);text-decoration:none;text-align:center;padding:10px 0;">${DEMO_PHONE_DISPLAY} — try it live</a>
    <a href="/dashboard" class="btn-login">Log in</a>
    <a href="/register" class="btn-primary">Start free trial</a>
  </div>
</div>

<!-- HERO -->
<section class="hero">
  <div class="hero-inner">
    <div class="hero-content">
      <div class="hero-eyebrow reveal">
        <div class="hero-eyebrow-dot"></div>
        Sounds Real. Books Smart. Never Misses a Call.
      </div>

      <h1 class="hero-h1 reveal reveal-delay-1">
        YOUR<br>
        PHONE<br>
        <span class="blue">NEVER</span><br>
        <span class="accent">SLEEPS</span>
      </h1>

      <p class="hero-sub reveal reveal-delay-2">
        Not a phone tree. Your caller has a <strong>real conversation</strong> — asks anything about your services, books the right appointment, and gets answers they actually understand. Most won't know it wasn't a person.
      </p>

      <div class="hero-actions reveal reveal-delay-2">
        <a href="/register" class="btn-hero">
          Start free trial
          <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </a>
        <a href="/demo" class="btn-ghost">Try live demo</a>
      </div>

      <div class="hero-stats reveal reveal-delay-3">
        <div class="hero-stat">
          <div class="hero-stat-n">30<span>+</span></div>
          <div class="hero-stat-l">business types</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-n">14<span> days</span></div>
          <div class="hero-stat-l">free trial</div>
        </div>
        <div class="hero-stat">
          <div class="hero-stat-n">&lt;2<span> rings</span></div>
          <div class="hero-stat-l">to pick up</div>
        </div>
      </div>
    </div>

    <!-- FEATURE GRID -->
    <div class="feat-grid-hero reveal reveal-delay-2">

      <div class="feat-tile">
        <div class="feat-tile-icon blue">
          <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014 12.5a19.8 19.8 0 01-3-8.61A2 2 0 013 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L7.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg>
        </div>
        <div class="feat-tile-h">Nobody Goes to Voicemail</div>
        <p class="feat-tile-p">Your customer calls at 9pm. Someone picks up. It sounds human. They book. You wake up to a new appointment.</p>
      </div>

      <div class="feat-tile">
        <div class="feat-tile-icon amber">
          <svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
        </div>
        <div class="feat-tile-h">Remembers Every Customer</div>
        <p class="feat-tile-p">Returning customers hear their name before they've said a word. No repeating their info. They feel known — and known customers come back.</p>
      </div>

      <div class="feat-tile">
        <div class="feat-tile-icon purple">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg>
        </div>
        <div class="feat-tile-h">Handles It All in One Call</div>
        <p class="feat-tile-p">"Tires and an alignment — how soon can you do both?" It figures out the fastest back-to-back booking, right staff, right equipment. Done.</p>
      </div>

      <div class="feat-tile">
        <div class="feat-tile-icon green">
          <svg viewBox="0 0 24 24"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
        </div>
        <div class="feat-tile-h">Shows You Why You're Losing Jobs</div>
        <p class="feat-tile-p">It logs why every caller didn't book — no Saturday slot, wrong service, sticker shock. You finally see the pattern, not just a missed-call count. No other receptionist tells you this.</p>
      </div>

    </div>
  </div>
</section>

<!-- LOGO BAR -->
<div class="logo-bar">
  <div class="logo-bar-inner">
    <span class="logo-bar-label">Works great for:</span>
    <div class="logo-bar-items">
      <span class="logo-bar-item">Auto Shops</span>
      <span class="logo-bar-item">Tire Services</span>
      <span class="logo-bar-item">Hair Salons</span>
      <span class="logo-bar-item">Barbershops</span>
      <span class="logo-bar-item">Gyms</span>
      <span class="logo-bar-item">Plumbers</span>
      <span class="logo-bar-item">HVAC</span>
      <span class="logo-bar-item">Landscaping</span>
      <span class="logo-bar-item">Real Estate</span>
    </div>
  </div>
</div>

<!-- PROBLEM SECTION -->
<section class="section" style="padding-top:80px;padding-bottom:80px;background:var(--bg2);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
  <div class="section-inner">
    <div class="problem-grid">
      <div>
        <div class="section-eyebrow reveal">The problem you already have</div>
        <h2 class="section-h2 reveal reveal-delay-1" style="margin-bottom:24px;">YOUR PHONE<br>IS COSTING<br>YOU JOBS.</h2>
        <p style="font-size:17px;font-weight:300;color:#888;line-height:1.7;margin-bottom:32px;max-width:460px;" class="reveal reveal-delay-2">
          You didn't miss that call because you didn't care. You missed it because you were doing the job. But the customer didn't wait — they called your competitor instead.
        </p>
        <div class="problem-points reveal reveal-delay-2">
          <div class="problem-point">
            <div class="problem-dot"></div>
            <p>Most callers who don't get a live answer <strong>don't call back.</strong> They move on to the next result on Google.</p>
          </div>
          <div class="problem-point">
            <div class="problem-dot"></div>
            <p>Service businesses miss a large share of inbound calls during the job, at lunch, and after hours — <strong>when customers are most likely to book.</strong></p>
          </div>
          <div class="problem-point">
            <div class="problem-dot"></div>
            <p>Every missed call in auto or home services represents a job that <strong>went somewhere else.</strong> One captured booking a week pays for a year of Secretary HQ.</p>
          </div>
        </div>
      </div>
      <div class="reveal reveal-delay-1">
        <div class="problem-card">
          <div class="problem-card-bar"></div>
          <div class="problem-card-eyebrow">THE MATH IS SIMPLE</div>
          <div class="problem-card-stat">1 job</div>
          <p class="problem-card-sub">A single captured booking per week covers the full cost of Secretary HQ for the year.</p>
          <div class="problem-card-divider"></div>
          <div class="problem-card-row">
            <div class="problem-card-row-item">
              <div class="problem-card-row-num amber">\$59.95</div>
              <div class="problem-card-row-label">Growth plan<br>per month</div>
            </div>
            <div class="problem-card-row-item">
              <div class="problem-card-row-num green">24/7</div>
              <div class="problem-card-row-label">Always on<br>never misses</div>
            </div>
          </div>
          <div class="problem-math">
            <div class="problem-math-title">No more after-hours voicemail.</div>
            <div class="problem-math-body">Secretary HQ answers at midnight the same as at noon — and books the appointment before your competitor picks up.</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- HOW IT WORKS -->
<section class="section" id="how">
  <div class="section-inner">
    <div class="section-eyebrow reveal">How it works</div>
    <h2 class="section-h2 reveal reveal-delay-1">LIVE IN UNDER<br>10 MINUTES</h2>
    <p class="section-sub reveal reveal-delay-2">Pick your business type. Answer a few questions. Get a real phone number. Your AI secretary is live before your next coffee gets cold.</p>
    <div class="steps reveal reveal-delay-2">
      <div class="step">
        <div class="step-num">01</div>
        <div class="step-icon"><svg viewBox="0 0 24 24"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg></div>
        <div class="step-h">Pick your template</div>
        <p class="step-p">Choose from 30 business types across 6 categories. Auto shop, salon, HVAC, plumber — each has the right words, services, and defaults already set up.</p>
      </div>
      <div class="step">
        <div class="step-num">02</div>
        <div class="step-icon"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></div>
        <div class="step-h">Add your team</div>
        <p class="step-p">Enter staff, their skills, working hours, and which bays or stations they use. The AI validates every booking against all three in real time.</p>
      </div>
      <div class="step">
        <div class="step-num">03</div>
        <div class="step-icon"><svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014 12.5a19.8 19.8 0 01-3-8.61A2 2 0 013 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L7.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg></div>
        <div class="step-h">Your number goes live</div>
        <p class="step-p">Pick an area code. We set up a real phone number and your AI receptionist automatically. Call it immediately — no waiting, no manual setup.</p>
      </div>
    </div>
  </div>
</section>

<!-- FEATURES -->
<section class="section features-bg" id="features">
  <div class="section-inner">
    <div class="section-eyebrow reveal">What it does</div>
    <h2 class="section-h2 reveal reveal-delay-1">WHAT MAKES IT<br>DIFFERENT</h2>
    <p class="section-sub reveal reveal-delay-2">Not just a phone answerer. A smart front desk that knows your business, your team, and your customers.</p>
    <div class="features-grid">

      <div class="feat-card reveal">
        <div class="feat-icon blue"><svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 014 12.5a19.8 19.8 0 01-3-8.61A2 2 0 013 2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L7.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/></svg></div>
        <div class="feat-h">Sounds Like You Hired Someone</div>
        <p class="feat-p">No menus. No robot voice. Your caller talks naturally, interrupts, asks follow-ups, changes their mind. It keeps up. Most won't know it wasn't a person.</p>
        <span class="feat-tag blue">Live calls</span>
      </div>

      <div class="feat-card reveal reveal-delay-1">
        <div class="feat-icon blue"><svg viewBox="0 0 24 24"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg></div>
        <div class="feat-h">Ask It Anything</div>
        <p class="feat-p">Upload your service guide and customers can ask anything — what a part does, why they need it, how long it takes, what it costs. &quot;What are struts?&quot; It answers. Customers who understand what they&apos;re paying for trust your business and come back.</p>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot green"></div>Explains services in plain language</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Answers from your own documents — not a generic script</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Covers parts, process, pricing, why</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>&quot;Can I see them after you take them off?&quot; Yes, it handles that too</div>
        </div>
      </div>

      <div class="feat-card reveal">
        <div class="feat-icon amber"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg></div>
        <div class="feat-h">Instant Proof in Their Inbox</div>
        <p class="feat-p">The moment they hang up, a confirmation email lands. Date, time, service — confirmed. They&apos;re confident. You skip the follow-up call.</p>
        <span class="feat-tag blue">Instant</span>
      </div>

      <div class="feat-card reveal reveal-delay-1">
        <div class="feat-icon purple"><svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg></div>
        <div class="feat-h">Knows Every Caller</div>
        <p class="feat-p">Returning customers heard by name before they say a word. Their history, what they usually get. No &quot;can I get your name again?&quot; — ever.</p>
        <span class="feat-tag green">No login required</span>
      </div>

      <div class="feat-card reveal">
        <div class="feat-icon blue"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
        <div class="feat-h">Your Team, Always Working</div>
        <p class="feat-p">Books against real staff schedules, real skills, real equipment — so nobody sits idle and nobody gets double-booked. One dashboard shows your whole day. Drag, reschedule, or book manually.</p>
        <span class="feat-tag blue">Dashboard</span>
      </div>

      <div class="feat-card reveal reveal-delay-1">
        <div class="feat-icon green"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></div>
        <div class="feat-h">Books the Right Person, the Right Spot</div>
        <p class="feat-p">Multi-service, back to back — it checks who&apos;s trained, what equipment is free, who&apos;s on shift, and finds the fastest slot. Your customer hangs up with a real appointment, not a callback.</p>
        <span class="feat-tag blue">Smart booking</span>
      </div>

    </div>
  </div>
</section>

<!-- CAPABILITIES — expandable "everything it does" grid -->
<section class="section" id="capabilities">
  <div class="section-inner">
    <div class="section-eyebrow reveal">Everything it does</div>
    <h2 class="section-h2 reveal reveal-delay-1">MORE THAN<br>ANSWERING</h2>
    <p class="section-sub reveal reveal-delay-2">It runs your whole front desk. Tap any card to see everything inside.</p>
    <div class="cap-grid reveal reveal-delay-2" id="cap-grid">

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-1">
        <span class="cap-ic" aria-hidden="true">📞</span>
        <span class="cap-title">Answers &amp; Books Calls</span>
        <span class="cap-hook">Answers 24/7 and books right on the call — sounds like a real person.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-1" role="region" aria-label="Answers and books calls" hidden>
        <div class="cap-panel-h">📞 Answers &amp; books calls</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>Answers every call, 24/7 — nights, weekends, when you're on another line</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Talks like a real person — natural back-and-forth, not a robot menu</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Knows your business — hours, prices, services, and policies</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Books appointments right on the call — no callback</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Recognizes returning callers and recalls their history</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Saves preferences mid-call ("prefers Maria", "last: oil change")</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Sends the call to you or takes a message</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Sounds how you want — pick the voice, speed, greeting, and name</div>
        </div>
      </div>

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-2">
        <span class="cap-ic" aria-hidden="true">📅</span>
        <span class="cap-title">Books Without Conflicts</span>
        <span class="cap-hook">Books the right person in the right spot — never double-books.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-2" role="region" aria-label="Books without conflicts" hidden>
        <div class="cap-panel-h">📅 Scheduling that won't double-book</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>A real calendar of your staff, shifts, services, and rooms/equipment</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>No conflicts — won't double-book, book the past, or book someone off-shift</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Books the right person — only staff with the right skill and room</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Handles time zones and late/overnight shifts</div>
        </div>
      </div>

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-3">
        <span class="cap-ic" aria-hidden="true">👤</span>
        <span class="cap-title">Customer Records</span>
        <span class="cap-hook">Remembers every caller and what they like.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-3" role="region" aria-label="Customer records" hidden>
        <div class="cap-panel-h">👤 Customer records</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>One address book — contact info, full appointment history, and notes</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Recognizes returning callers by their phone number</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Recalls their preferences on the next call</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Search, view, and edit any customer in the dashboard</div>
        </div>
      </div>

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-4">
        <span class="cap-ic" aria-hidden="true">📝</span>
        <span class="cap-title">Call Logs &amp; Recaps</span>
        <span class="cap-hook">Every call recorded, transcribed, and summarized.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-4" role="region" aria-label="Call logs and recaps" hidden>
        <div class="cap-panel-h">📝 Call logs &amp; recaps</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>Every call logged — who called, how long, what happened</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Full transcript plus a one-line summary of each call</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>See exactly what a call booked — and delete old calls anytime</div>
        </div>
      </div>

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-5">
        <span class="cap-ic" aria-hidden="true">📊</span>
        <span class="cap-title">Knows the WHY</span>
        <span class="cap-badge">Only us</span>
        <span class="cap-hook">Tells you <em>why</em> callers didn't book — not just how many.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-5" role="region" aria-label="Knows the why" hidden>
        <div class="cap-panel-h">📊 Understand your business</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>Simple stats — calls, bookings, customers, today and this week</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Why people didn't book — no time that worked, wrong service, price</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Busy times and staffing gaps — where your schedule has holes</div>
        </div>
      </div>

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-6">
        <span class="cap-ic" aria-hidden="true">🔔</span>
        <span class="cap-title">Reminders</span>
        <span class="cap-hook">Cuts no-shows with automatic email reminders.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-6" role="region" aria-label="Reminders" hidden>
        <div class="cap-panel-h">🔔 Reminders</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>Automatic reminders and confirmations by email (text isn&apos;t available yet)</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Only to customers who agreed to be contacted — no spam risk</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Fewer no-shows and last-minute gaps</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Retries automatically if a send doesn't go through</div>
        </div>
      </div>

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-7">
        <span class="cap-ic" aria-hidden="true">🔗</span>
        <span class="cap-title">Works With Your Tools</span>
        <span class="cap-hook">Syncs with Google Calendar, Outlook, and Square.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-7" role="region" aria-label="Works with your tools" hidden>
        <div class="cap-panel-h">🔗 Works with what you already use</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>Google Calendar and Outlook — bookings land on your calendar automatically</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Square — keeps your customer list in sync</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>Works even if you use a spreadsheet or nothing — no lock-in</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Get a business number or route your existing one</div>
        </div>
      </div>

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-8">
        <span class="cap-ic" aria-hidden="true">⚡</span>
        <span class="cap-title">10-Minute Setup</span>
        <span class="cap-hook">Scan your site or upload a sheet — it teaches itself.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-8" role="region" aria-label="Ten minute setup" hidden>
        <div class="cap-panel-h">⚡ Easy to set up and teach</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>Guided setup wizard, with a simple solo-business mode</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Teach it fast — scan your website or upload a document/FAQ</div>
          <div class="val-layer"><div class="val-layer-dot blue"></div>You review everything before it goes live</div>
        </div>
      </div>

      <button class="cap-tile" type="button" aria-expanded="false" aria-controls="cap-panel-9">
        <span class="cap-ic" aria-hidden="true">🔒</span>
        <span class="cap-title">Yours &amp; Secure</span>
        <span class="cap-hook">Private, with roles for your team — try it free.</span>
        <span class="cap-more">See all <span class="cap-caret" aria-hidden="true">▾</span></span>
      </button>
      <div class="cap-panel" id="cap-panel-9" role="region" aria-label="Yours and secure" hidden>
        <div class="cap-panel-h">🔒 Yours &amp; secure</div>
        <div class="val-layers">
          <div class="val-layer"><div class="val-layer-dot blue"></div>Private and secure — each business is walled off</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Logins with owner, manager, and front-desk roles</div>
          <div class="val-layer"><div class="val-layer-dot green"></div>Try it free — instant demo with sample data, no commitment</div>
        </div>
      </div>

    </div>
  </div>
</section>

<!-- PRICING -->
<section class="section" id="pricing">
  <div class="section-inner">
    <div class="section-eyebrow reveal">Simple pricing</div>
    <h2 class="section-h2 reveal reveal-delay-1">PAY FOR WHAT<br>YOU NEED</h2>
    <p class="section-sub reveal reveal-delay-2">Phone number included on every plan. 14-day free trial for new accounts. Card required — cancel before day 14 and you pay nothing. No setup fee.</p>
    <div class="pricing-grid">
      <div class="price-card reveal">
        <div class="price-name">Solo</div>
        <div class="price-amount"><span class="price-dollar">\$</span><span class="price-num" data-monthly="29.95">29.95</span><span class="price-period">/mo</span></div>
        <p class="price-desc">The solo operator's secret weapon. Captures every call, books every job.</p>
        <hr class="price-divider">
        <ul class="price-features">
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>30 AI-handled calls/month</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>\$1.00 per extra call — your line never stops answering</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Phone number included</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Email confirmations</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Customer records</li>
        </ul>
        <a href="/register" class="price-btn outline">Start free trial</a>
      </div>
      <div class="price-card featured reveal reveal-delay-1">
        <div class="price-name">Growth</div>
        <div class="price-amount"><span class="price-dollar">\$</span><span class="price-num" data-monthly="59.95">59.95</span><span class="price-period">/mo</span></div>
        <p class="price-desc">Your full front desk. Staff matching, visual schedule, calendar sync, and FAQ library — all included.</p>
        <hr class="price-divider">
        <ul class="price-features">
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>100 AI-handled calls/month</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>\$0.75 per extra call</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Everything in Solo</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Visual schedule for your whole team</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Google Calendar sync</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>FAQ library (upload PDFs or text)</li>
        </ul>
        <a href="/register" class="price-btn filled">Start free trial</a>
      </div>
      <div class="price-card reveal reveal-delay-2">
        <div class="price-name">Professional</div>
        <div class="price-amount"><span class="price-dollar">\$</span><span class="price-num" data-monthly="149.95">149.95</span><span class="price-period">/mo</span></div>
        <p class="price-desc">High-volume businesses. Detailed reports and custom words for your trade.</p>
        <hr class="price-divider">
        <ul class="price-features">
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>300 AI-handled calls/month</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>\$0.60 per extra call</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Everything in Growth</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Detailed reports &amp; business trends</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Custom words &amp; phrases for your trade</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Priority support</li>
        </ul>
        <a href="/register" class="price-btn outline">Start free trial</a>
      </div>
      <div class="price-card reveal reveal-delay-2" style="border-color:rgba(245,158,11,0.3);background:linear-gradient(180deg,rgba(245,158,11,0.06) 0%,var(--bg3) 100%)">
        <div class="price-name" style="color:var(--amber)">Enterprise</div>
        <div class="price-amount"><span class="price-dollar">\$</span><span class="price-num" style="color:var(--amber)">1,200</span><span class="price-period">+/mo</span></div>
        <p class="price-desc">For multi-location businesses, franchises, or agencies. Your branding on the dashboard. Custom AI voice. Dedicated support.</p>
        <hr class="price-divider">
        <ul class="price-features">
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Everything in Professional</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Multiple locations / businesses</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Your branding on the dashboard</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Custom AI voice &amp; personality</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Dedicated account support</li>
          <li><div class="check"><svg viewBox="0 0 12 12"><polyline points="2 6 5 9 10 3"/></svg></div>Custom integrations &amp; uptime guarantee</li>
        </ul>
        <a href="mailto:sales@secretaryhq.com" class="price-btn outline" style="border-color:rgba(245,158,11,0.3);color:var(--amber)">Talk to us</a>
      </div>
    </div>
    <p class="trial-note reveal">New accounts get a <span>14-day free trial</span> on any plan. A card is required to start it, and you are not charged until the trial ends. No setup fee. Cancel anytime.</p>
  </div>
</section>

<!-- INDUSTRIES -->
<section class="section" id="industries" style="padding-top:0;">
  <div class="section-inner">
    <div class="section-eyebrow reveal">Industries</div>
    <h2 class="section-h2 reveal reveal-delay-1">BUILT FOR YOUR<br>KIND OF BUSINESS</h2>
    <p class="section-sub reveal reveal-delay-2">30 business types across 6 categories. Each template uses the right words, the right defaults, and the right scheduling rules for your trade.</p>
    <div class="biz-grid reveal reveal-delay-2">
      <div class="biz-chip">Auto Repair Shop</div>
      <div class="biz-chip">Body &amp; Paint Shop</div>
      <div class="biz-chip">Car Detailing</div>
      <div class="biz-chip">Car Wash</div>
      <div class="biz-chip">Mobile Tire Shop</div>
      <div class="biz-chip">Quick Lube / Oil Change</div>
      <div class="biz-chip">Hair Salon</div>
      <div class="biz-chip">Barbershop</div>
      <div class="biz-chip">Nail Salon</div>
      <div class="biz-chip">Spa &amp; Wellness</div>
      <div class="biz-chip">Lash &amp; Brow Studio</div>
      <div class="biz-chip">Med Spa</div>
      <div class="biz-chip">Personal Training</div>
      <div class="biz-chip">Yoga Studio</div>
      <div class="biz-chip">Bakery</div>
      <div class="biz-chip">Catering Service</div>
      <div class="biz-chip">Plumbing Service</div>
      <div class="biz-chip">HVAC Service</div>
      <div class="biz-chip">Electrical Service</div>
      <div class="biz-chip">Cleaning Service</div>
      <div class="biz-chip">Landscaping Service</div>
      <div class="biz-chip">Pest Control</div>
      <div class="biz-chip">Locksmith</div>
      <div class="biz-chip">Garage Door Service</div>
      <div class="biz-chip">Photography Studio</div>
      <div class="biz-chip">Real Estate Showings</div>
      <div class="biz-chip">Insurance Agency</div>
      <div class="biz-chip">Tax Preparation</div>
      <div class="biz-chip">Tutoring Service</div>
      <div class="biz-chip">Answering &amp; Scheduling</div>
    </div>
  </div>
</section>

<!-- CTA BAND -->
<section class="cta-band">
  <h2 class="cta-band-h reveal">YOUR NEXT CALL<br>IS ABOUT TO<br><span style="color:var(--blue-lt)">GET ANSWERED.</span></h2>
  <p class="cta-band-sub reveal reveal-delay-1">Sign up in two minutes. Finish the quick setup. Call your new number and hear your AI secretary pick up. It&apos;s that fast.</p>
  <div class="cta-band-actions reveal reveal-delay-2">
    <a href="/register" class="btn-hero">Start free trial<svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg></a>
    <div class="cta-number">
      <span class="cta-number-label">Try it live →</span>
      <span style="color:var(--blue-lt)">${DEMO_PHONE_DISPLAY}</span>
    </div>
  </div>
</section>

<!-- FOOTER -->
<footer>
  <div class="footer-logo">SECRETARY HQ</div>
  <div class="footer-links">
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
    <a href="/dpa">DPA</a>
    <a href="mailto:sales@secretaryhq.com">Contact</a>
  </div>
  <div class="footer-copy">© 2026 Secretary HQ. All rights reserved.</div>
</footer>

`;
// NOTE: no <script> in LANDING_HTML — markup injected via
// dangerouslySetInnerHTML never executes scripts. ALL landing interactivity
// (reveal observer, pricing toggle, hamburger menu, capability grid) is
// wired from useEffect hooks in LandingPage below.

export default function LandingPage() {
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (token) {
      router.replace('/dashboard');
      return;
    }
    setChecked(true);
  }, [router]);

  useEffect(() => {
    if (!checked) return;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add('visible');
        });
      },
      { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
    );
    document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [checked]);

  // Measures the real announce-bar + nav height so the mobile menu's top
  // offset never has to guess — the bar can wrap to 2 lines on narrow
  // screens, and a hardcoded px offset would either gap or overlap it.
  useEffect(() => {
    if (!checked) return;
    const topFixed = document.querySelector<HTMLElement>('.top-fixed');
    if (!topFixed) return;
    const setOffset = () => {
      document.documentElement.style.setProperty('--top-offset', `${topFixed.offsetHeight}px`);
    };
    setOffset();
    const observer = new ResizeObserver(setOffset);
    observer.observe(topFixed);
    window.addEventListener('resize', setOffset);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', setOffset);
    };
  }, [checked]);

  // Hamburger menu — iPad-ready (44px targets, backdrop tap-to-dismiss,
  // body scroll lock, Escape). Same never-executes reason as above: the
  // menu could not open at all while this lived in the inline <script>.
  useEffect(() => {
    if (!checked) return;
    const btn = document.getElementById('hamburger-btn');
    const menu = document.getElementById('mobile-menu');
    const backdrop = document.getElementById('mobile-backdrop');
    if (!btn || !menu || !backdrop) return;
    const spans = Array.from(btn.querySelectorAll<HTMLElement>('span'));
    const open = () => {
      menu.classList.add('open');
      backdrop.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      if (spans.length >= 3) {
        spans[0].style.transform = 'translateY(7px) rotate(45deg)';
        spans[1].style.opacity = '0';
        spans[2].style.transform = 'translateY(-7px) rotate(-45deg)';
      }
    };
    const close = () => {
      menu.classList.remove('open');
      backdrop.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      spans.forEach((s) => {
        s.style.transform = '';
        s.style.opacity = '';
      });
    };
    const onToggle = () => (menu.classList.contains('open') ? close() : open());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const links = Array.from(document.querySelectorAll('.nav-mobile-menu a'));
    btn.addEventListener('click', onToggle);
    backdrop.addEventListener('click', close);
    backdrop.addEventListener('touchend', close, { passive: true });
    links.forEach((a) => a.addEventListener('click', close));
    document.addEventListener('keydown', onKey);
    return () => {
      btn.removeEventListener('click', onToggle);
      backdrop.removeEventListener('click', close);
      backdrop.removeEventListener('touchend', close);
      links.forEach((a) => a.removeEventListener('click', close));
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [checked]);

  // Capability grid — expand one tile at a time to reveal its full feature list.
  // Wired here (not in the injected LANDING_HTML <script>, which never executes —
  // scripts set via dangerouslySetInnerHTML don't run).
  useEffect(() => {
    if (!checked) return;
    const grid = document.getElementById('cap-grid');
    if (!grid) return;
    const tiles = Array.from(grid.querySelectorAll<HTMLButtonElement>('.cap-tile'));
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const panelFor = (t: Element) => {
      const id = t.getAttribute('aria-controls');
      return id ? document.getElementById(id) : null;
    };
    const close = (t: Element) => {
      t.setAttribute('aria-expanded', 'false');
      const p = panelFor(t);
      if (p) {
        p.hidden = true;
        p.classList.remove('open');
      }
    };
    const closeAll = (except: Element | null) =>
      tiles.forEach((t) => {
        if (t !== except) close(t);
      });
    const makeHandler = (tile: HTMLButtonElement) => () => {
      const isOpen = tile.getAttribute('aria-expanded') === 'true';
      closeAll(tile);
      if (isOpen) {
        close(tile);
        return;
      }
      tile.setAttribute('aria-expanded', 'true');
      const p = panelFor(tile);
      if (p) {
        // Open the panel full-width under the WHOLE row: move it right after the
        // last tile of the clicked tile's visual row. Otherwise a panel opened
        // from a non-last tile forces its own row mid-way and leaves a hole —
        // trailing tiles appeared to "disappear to the right". Row is computed
        // while all panels are hidden (out of flow), so offsetTop is accurate.
        const rowTop = tile.offsetTop;
        const rowTiles = tiles.filter((t) => t.offsetTop === rowTop);
        const lastInRow = rowTiles[rowTiles.length - 1];
        if (lastInRow && lastInRow.nextSibling !== p) {
          grid.insertBefore(p, lastInRow.nextSibling);
        }
        p.hidden = false;
        p.classList.add('open');
        window.setTimeout(() => {
          // Guard against a rapid open→close: only scroll if still open.
          if (!p.hidden)
            p.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
        }, 60);
      }
    };
    const handlers = tiles.map((t) => {
      const h = makeHandler(t);
      t.addEventListener('click', h);
      return h;
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeAll(null);
    };
    // Click anywhere outside the open tile/panel closes it (no need to re-click the tile).
    const onDocClick = (e: MouseEvent) => {
      const openTile = tiles.find((t) => t.getAttribute('aria-expanded') === 'true');
      if (!openTile) return;
      const p = panelFor(openTile);
      const target = e.target as Node;
      if (openTile.contains(target) || (p && p.contains(target))) return;
      closeAll(null);
    };
    // Row membership changes at breakpoints — close on resize to avoid stale placement.
    const onResize = () => closeAll(null);
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onDocClick);
    window.addEventListener('resize', onResize);
    return () => {
      tiles.forEach((t, i) => t.removeEventListener('click', handlers[i]));
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('resize', onResize);
    };
  }, [checked]);

  if (!checked) return null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: LANDING_CSS }} />
      <div dangerouslySetInnerHTML={{ __html: LANDING_HTML }} />
    </>
  );
}
