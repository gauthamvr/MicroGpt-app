#!/usr/bin/env node
// Audit native .so files for 16 KB page alignment, per
// https://developer.android.com/guide/practices/page-sizes.
//
// A library is 16-KB-page compatible iff every PT_LOAD program header has
// p_align >= 0x4000 AND p_offset is a multiple of 0x4000. NDK r27+ defaults
// to 16-KB-aligned output. Older NDK builds (which is most prebuilts in
// the wild) emit p_align = 0x1000 (4 KB) and will fail to load on a 16-KB
// page device.
//
// Usage: node scripts/check-16k-alignment.js [path] [path] ...
// With no args, scans the project's known .so locations.

const fs = require('fs');
const path = require('path');

const PT_LOAD = 1;
const PAGE_16K = 0x4000;

function checkSo(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { file, error: `read failed: ${e.message}` };
  }
  // ELF magic
  if (buf.length < 64 || buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
    return { file, error: 'not an ELF file' };
  }
  const ei_class = buf[4]; // 1 = 32-bit, 2 = 64-bit
  if (ei_class !== 2) return { file, error: '32-bit ELF (we only ship arm64-v8a)' };

  const e_phoff = Number(buf.readBigUInt64LE(0x20));
  const e_phentsize = buf.readUInt16LE(0x36);
  const e_phnum = buf.readUInt16LE(0x38);

  let aligned = true;
  let minAlign = Infinity;
  let offsetIssue = false;
  for (let i = 0; i < e_phnum; i++) {
    const off = e_phoff + i * e_phentsize;
    const p_type = buf.readUInt32LE(off + 0x00);
    if (p_type !== PT_LOAD) continue;
    const p_offset = Number(buf.readBigUInt64LE(off + 0x08));
    const p_align = Number(buf.readBigUInt64LE(off + 0x30));
    if (p_align < PAGE_16K) aligned = false;
    if (p_align < minAlign) minAlign = p_align;
    if (p_offset % PAGE_16K !== 0) offsetIssue = true;
  }
  return {
    file,
    aligned,
    minAlign: minAlign === Infinity ? 0 : minAlign,
    offsetIssue,
    sizeMB: (buf.length / 1024 / 1024).toFixed(1),
  };
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  // Default scan locations
  const roots = [
    'modules/expo-stable-diffusion/android/src/main/jniLibs/arm64-v8a',
    'modules/expo-stable-diffusion/android/src/main/assets/qnnlibs',
    'node_modules/llama.rn/android/src/main/jniLibs/arm64-v8a',
  ];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const f of fs.readdirSync(r)) {
      if (f.endsWith('.so')) targets.push(path.join(r, f));
    }
  }
}

const rows = targets.map(checkSo);
const ok = rows.filter((r) => r.aligned).length;
const bad = rows.filter((r) => !r.aligned && !r.error);
const errs = rows.filter((r) => r.error);

console.log(`Scanned ${rows.length} .so files. Aligned: ${ok}. Misaligned: ${bad.length}. Errors: ${errs.length}.\n`);

console.log('=== 16-KB-aligned (OK on Android 15+ 16-KB devices) ===');
for (const r of rows) {
  if (r.aligned) console.log(`  ${r.file}  (${r.sizeMB} MB, p_align=0x${r.minAlign.toString(16)})`);
}
console.log('\n=== NOT aligned (will fail on 16-KB-page devices) ===');
for (const r of bad) {
  console.log(`  ${r.file}  (${r.sizeMB} MB, p_align=0x${r.minAlign.toString(16)}${r.offsetIssue ? ', offset-misaligned' : ''})`);
}
if (errs.length) {
  console.log('\n=== Errors ===');
  for (const r of errs) console.log(`  ${r.file}: ${r.error}`);
}

process.exit(bad.length > 0 ? 1 : 0);
