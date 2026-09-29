const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('web/monitor.js', 'utf8');
const css = fs.readFileSync('web/monitor.css', 'utf8');
const helpers = source.slice(source.indexOf('function monitorPercent('), source.indexOf('function monitorUptime('));

function context() {
  const ctx = { esc: value => String(value ?? '') };
  vm.createContext(ctx);
  vm.runInContext(helpers, ctx);
  return ctx;
}

test('resource meters use stable semantic color classes', () => {
  const ctx = context();
  const cpu = vm.runInContext('monitorMeter("CPU", 25, "cpu")', ctx);
  const memory = vm.runInContext('monitorMeter("内存", 50, "memory")', ctx);
  const disk = vm.runInContext('monitorMeter("磁盘", 75, "disk")', ctx);
  const load = vm.runInContext('monitorLoadMeter(1.25)', ctx);

  assert.match(cpu, /monitor-meter-cpu/);
  assert.match(memory, /monitor-meter-memory/);
  assert.match(disk, /monitor-meter-disk/);
  assert.match(load, /monitor-meter-load/);
  assert.match(load, />1\.25</);
});

test('latency and packet loss severity classes are deterministic', () => {
  const ctx = context();
  assert.equal(vm.runInContext('monitorLatencyClass(80)', ctx), 'ping-value-good');
  assert.equal(vm.runInContext('monitorLatencyClass(150)', ctx), 'ping-value-warn');
  assert.equal(vm.runInContext('monitorLatencyClass(250)', ctx), 'ping-value-bad');
  assert.equal(vm.runInContext('monitorLossClass(0)', ctx), 'ping-loss-good');
  assert.equal(vm.runInContext('monitorLossClass(2)', ctx), 'ping-loss-warn');
  assert.equal(vm.runInContext('monitorLossClass(8)', ctx), 'ping-loss-bad');
});

test('monitor cards use compact responsive grid and mapped colors', () => {
  assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /align-items:\s*start/);
  assert.match(css, /@media \(max-width: 1120px\)[^{]*\{[^}]*\.monitor-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/s);
  assert.match(css, /\.monitor-meter-cpu[^{]*[\s\S]*?#59c9bd/);
  assert.match(css, /\.monitor-meter-memory[^{]*[\s\S]*?#a884e8/);
  assert.match(css, /\.monitor-meter-disk[^{]*[\s\S]*?#f0a45f/);
  assert.match(css, /\.monitor-meter-load[^{]*[\s\S]*?#ec87b6/);
  assert.match(css, /\.traffic-up\s*\{[^}]*#f0b64f/);
  assert.match(css, /\.traffic-down\s*\{[^}]*#56d39a/);
});
