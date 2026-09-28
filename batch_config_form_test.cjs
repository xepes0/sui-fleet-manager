const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const batchSource = fs.readFileSync('web/batch-config.js', 'utf8');
const batchFunctions = batchSource.slice(batchSource.indexOf('const bcOutboundTypes='), batchSource.indexOf('function bcResetPreview()'));
const batch = {structuredClone};
batch.crypto = require('node:crypto').webcrypto;
batch.bc = {inboundCopy: false, tlsName: 'shared-cert'};
vm.createContext(batch);
vm.runInContext(batchFunctions, batch);

test('guided client form builds credentials from selected inbound protocols', () => {
  batch.bc.data = {inbounds: [{tag: 'vless-in', type: 'vless'}, {tag: 'trojan-in', type: 'trojan'}]};
  batch.bc.form = batch.bcClientForm();
  batch.bc.form.name = 'alice';
  batch.bc.form.inbounds = ['vless-in', 'trojan-in'];
  batch.bcSyncClientCredentials();
  const object = batch.bcPrepareNewObject('clients', batch.bc.form);
  assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(object.config))), ['vless', 'trojan']);
  assert.match(object.config.vless.uuid, /^[0-9a-f-]{36}$/);
  assert.ok(object.config.trojan.password.length >= 20);
  assert.deepEqual(JSON.parse(JSON.stringify(object.inbounds)), []);
  assert.equal(object.remark, 'alice');
});

test('new client combines credentials from different server inbound selections', () => {
  batch.bc.data = {inbounds: [{tag: 'us-vless', type: 'vless'}]};
  batch.bc.form = batch.bcClientForm();
  batch.bc.form.name = 'shared-user';
  batch.bc.inboundOptions = {
    1: {items: [{tag: 'us-vless', type: 'vless'}]},
    2: {items: [{tag: 'hk-hy2', type: 'hysteria2'}]},
  };
  batch.bc.clientTagsByServer = {1: ['us-vless'], 2: ['hk-hy2']};
  batch.bcSyncClientCredentials();
  assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(batch.bc.form.config))), ['vless', 'hysteria2']);
  assert.ok(batch.bc.form.config.hysteria2.password);
  batch.bc.clientTagsByServer = {};
});

test('editing a client adds credentials when a new protocol inbound is selected', () => {
  batch.bc.data = {inbounds: [{id: 4, tag: 'vless-in', type: 'vless'}, {id: 9, tag: 'hy2-in', type: 'hysteria2'}]};
  batch.bc.form = {name: 'alice', inbounds: [4, 9], config: {vless: {name: 'alice', uuid: '00000000-0000-4000-8000-000000000000'}}};
  const marked = [];
  batch.bcSelectedInboundTags = () => ['vless-in', 'hy2-in'];
  batch.bcMark = path => marked.push(path);
  batch.bcAddMissingClientCredentials();
  assert.ok(batch.bc.form.config.hysteria2.password.length >= 20);
  assert.deepEqual(JSON.parse(JSON.stringify(marked)), [['config', 'hysteria2']]);
  assert.equal(batch.bc.form.config.vless.uuid, '00000000-0000-4000-8000-000000000000');
});

test('guided inbound form validates listener and TLS requirements', () => {
  const inbound = batch.bcInboundForm('hysteria2');
  inbound.tag = 'hy2-hk';
  assert.equal(inbound.listen_port, 443);
  batch.bc.tlsName = 'none';
  assert.throws(() => batch.bcPrepareNewObject('inbounds', inbound), /TLS 证书/);
  batch.bc.tlsName = 'shared-cert';
  assert.equal(batch.bcPrepareNewObject('inbounds', inbound).tag, 'hy2-hk');
  inbound.listen_port = 70000;
  assert.throws(() => batch.bcPrepareNewObject('inbounds', inbound), /监听端口/);
});

test('copied inbound changes only edited protocol fields', () => {
  const source = {id: 4, tag: 'old', type: 'vless', listen: '::', listen_port: 443, tls_id: 8, transport: {type: 'ws', path: '/old'}, sniff: true};
  const form = batch.bcCopyInboundForm(source, 'new');
  const original = structuredClone(form);
  form.listen_port = 8443;
  form.transport.path = '/new';
  assert.deepEqual(JSON.parse(JSON.stringify(batch.bcCopiedFieldPatch(original, form))), [{op: 'set', path: ['transport', 'path'], value: '/new'}]);
  assert.equal(form.id, undefined);
  assert.equal(form.sniff, true);
});

test('new SOCKS outbound exposes and submits credentials', () => {
  const form = batch.bcOutboundForm('socks');
  assert.equal(Object.hasOwn(form, 'username'), true);
  assert.equal(Object.hasOwn(form, 'password'), true);
  form.tag = 'socks-hk';
  form.server = 'proxy.example.com';
  form.username = 'alice';
  form.password = 'chosen-secret';
  const object = batch.bcPrepareNewObject('outbounds', form);
  assert.equal(object.username, 'alice');
  assert.equal(object.password, 'chosen-secret');
  assert.equal(object.server_port, 1080);
});

test('switching outbound protocol clears unrelated credentials', () => {
  const socks = batch.bcOutboundForm('socks');
  socks.tag = 'proxy';
  socks.server = 'proxy.example.com';
  socks.password = 'old-socks-secret';
  const trojan = batch.bcOutboundForm('trojan', socks);
  assert.equal(trojan.password, '');
  assert.equal(trojan.tag, 'proxy');
  assert.throws(() => batch.bcPrepareNewObject('outbounds', trojan), /密码/);
  trojan.password = 'new-trojan-secret';
  assert.equal(batch.bcPrepareNewObject('outbounds', trojan).password, 'new-trojan-secret');
});

test('batch SOCKS outbound writes UDP over TCP using the sing-box structure', () => {
  const form = batch.bcOutboundForm('socks');
  form.tag = 'socks-hk';
  form.server = 'proxy.example.com';
  assert.equal(Object.hasOwn(batch.bcPrepareNewObject('outbounds', form), 'udp_over_tcp'), false);
  form.udp_over_tcp = '2';
  assert.deepEqual(JSON.parse(JSON.stringify(batch.bcPrepareNewObject('outbounds', form).udp_over_tcp)), {enabled: true, version: 2});
  form.udp_over_tcp = '1';
  assert.equal(batch.bcPrepareNewObject('outbounds', form).udp_over_tcp.version, 1);
  form.version = '4';
  assert.throws(() => batch.bcPrepareNewObject('outbounds', form), /仅支持 SOCKS5/);
  form.version = '5';
  form.network = 'tcp';
  assert.throws(() => batch.bcPrepareNewObject('outbounds', form), /需要启用 UDP/);
});

test('batch outbound omits blank optional fields and keeps entered SNI', () => {
  const form = batch.bcOutboundForm('trojan');
  form.tag = 'trojan-hk';
  form.server = 'proxy.example.com';
  form.password = 'chosen-secret';
  const minimal = batch.bcPrepareNewObject('outbounds', form);
  assert.equal(Object.hasOwn(minimal, 'detour'), false);
  assert.equal(Object.hasOwn(minimal.tls, 'server_name'), false);
  form.detour = 'upstream';
  form.tls.server_name = 'example.com';
  const configured = batch.bcPrepareNewObject('outbounds', form);
  assert.equal(configured.detour, 'upstream');
  assert.equal(configured.tls.server_name, 'example.com');
});

test('extra sing-box fields start collapsed below ordinary outbound fields', () => {
  const renderSource = batchSource.slice(batchSource.indexOf('function bcFields('), batchSource.indexOf('function bcError('));
  const context = {
    bc: {mode: 'new', tab: 'outbounds', ops: new Map()},
    bcOutboundTypes: [['socks', 'SOCKS']],
    bcPath: path => encodeURIComponent(JSON.stringify(path)),
    bcKey: path => JSON.stringify(path),
    fcKind: value => typeof value,
    fcSecret: key => key === 'password',
    fcNames: {tag: 'Tag', password: '密码', udp_over_tcp: 'UDP over TCP'},
    esc: value => String(value),
  };
  vm.createContext(context);
  vm.runInContext(renderSource, context);
  const markup = context.bcFields({tag: 'socks-hk', password: ''}, [], 0);
  assert.match(markup, /<details class="batch-config-extra"/);
  assert.doesNotMatch(markup, /<details class="batch-config-extra"[^>]*\bopen\b/);
  assert.ok(markup.indexOf('密码') < markup.indexOf('高级参数（可选）'));
  assert.ok(markup.indexOf('sing-box 字段名') > markup.indexOf('高级参数（可选）'));
  const socks = batch.bcOutboundForm('socks');
  const socksMarkup = context.bcFields(socks, [], 0);
  assert.match(socksMarkup, /UDP over TCP/);
  assert.match(socksMarkup, /启用 · 版本 2/);
  assert.ok(socksMarkup.indexOf('UDP over TCP') < socksMarkup.indexOf('高级参数（可选）'));
});

test('new user accepts explicit inbound protocol password', () => {
  const source = fs.readFileSync('web/app.js', 'utf8');
  const buildClientSource = source.slice(source.indexOf('function buildClient(ids)'), source.indexOf('function buildRoute()'));
  const fields = {
    'new-client-name': {value: 'alice'},
    'new-client-remark': {value: 'Alice'},
    'new-client-volume': {value: '0'},
    'new-client-expiry': {value: ''},
    'new-client-password': {value: 'chosen-inbound-secret'},
    'new-client-uuid': {value: ''},
    'new-client-enable': {checked: true},
  };
  const context = {
    $: id => fields[id],
    requiredValue: id => fields[id].value,
    state: {servers: [{id: 1, name: 'test'}], details: {1: {inbounds: {inbounds: [{id: 7, type: 'trojan'}]}}}},
    document: {querySelectorAll: () => [{value: '7'}]},
    crypto: {randomUUID: () => '00000000-0000-4000-8000-000000000000'},
  };
  vm.createContext(context);
  vm.runInContext(buildClientSource, context);
  const result = context.buildClient([1]);
  assert.equal(result.client.config.trojan.password, 'chosen-inbound-secret');
  assert.deepEqual(JSON.parse(JSON.stringify(result.inbounds_by_server)), {'1': [7]});
});


test('changing target servers keeps an in-progress batch edit draft when the source stays selected', async () => {
  const helperSource = batchSource.slice(batchSource.indexOf('function bcResetPreview'), batchSource.indexOf('function bcSelect()'));
  const elements = {
    'batch-config-preview': {classList: {add() {}}},
    'batch-config-result': {classList: {add() {}}},
    'batch-config-servers': {innerHTML: ''},
    'batch-config-content': {innerHTML: ''},
  };
  const draft = {tag: 'shared', server: 'edited.example.com'};
  const ops = new Map([['["server"]', {op: 'set', path: ['server'], value: 'edited.example.com'}]]);
  let rendered = 0;
  const context = {
    bc: {preview: null, data: {outbounds: []}, source: {id: 1}, mode: 'edit', tab: 'outbounds', form: draft, ops, publicAddrs: {}},
    state: {selected: new Set([1, 2]), servers: [{id: 1, name: 'one', region: 'US'}, {id: 2, name: 'two', region: 'HK'}]},
    $: id => elements[id],
    esc: value => String(value),
    structuredClone,
    bcRender: () => { rendered++; },
  };
  vm.createContext(context);
  vm.runInContext(helperSource, context);
  await context.bcSelectionChanged();
  assert.equal(context.bc.form.server, 'edited.example.com');
  assert.equal(context.bc.ops.size, 1);
  assert.equal(rendered, 1);
});

test('batch result can stay visible while preview state is reset after execution', () => {
  const resetSource = batchSource.slice(batchSource.indexOf('function bcResetPreview'), batchSource.indexOf('function bcSelected()'));
  const state = {previewHidden: false, resultHidden: false};
  const context = {
    bc: {preview: {id: 'x'}},
    $: id => ({
      classList: {
        add(name) {
          if (id === 'batch-config-preview' && name === 'hidden') state.previewHidden = true;
          if (id === 'batch-config-result' && name === 'hidden') state.resultHidden = true;
        },
      },
    }),
  };
  vm.createContext(context);
  vm.runInContext(resetSource, context);
  context.bcResetPreview(true);
  assert.equal(context.bc.preview, null);
  assert.equal(state.previewHidden, true);
  assert.equal(state.resultHidden, false);
});
