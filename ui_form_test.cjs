const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('web/app.js', 'utf8');
const formSource = source.slice(source.indexOf('function requiredValue('), source.indexOf('function buildClient('));

function createForm({enabled, uotVersion = '2', socksVersion = '5'}) {
  const fields = {
    'object-mode': {value: 'new'},
    'object-new-tag': {value: 'test-socks'},
    'object-type': {value: 'socks'},
    'new-outbound-server': {value: 'example.invalid'},
    'new-outbound-port': {value: '1080'},
    'new-outbound-user': {value: 'test-user'},
    'new-outbound-password': {value: 'test-password'},
    'new-outbound-version': {value: socksVersion},
    'new-outbound-udp': {checked: enabled},
    'new-outbound-udp-version': {value: uotVersion},
    'new-outbound-tls': {checked: false},
    'new-outbound-sni': {value: ''},
  };
  const context = {$: id => fields[id]};
  vm.createContext(context);
  vm.runInContext(formSource, context);
  return context.buildCreate('outbound_create').object;
}

test('SOCKS UDP over TCP uses the S-UI object format', () => {
  const object = createForm({enabled: true});
  assert.deepEqual(JSON.parse(JSON.stringify(object.udp_over_tcp)), {enabled: true, version: 2});
  assert.equal(object.version, '5');
});

test('SOCKS UDP over TCP version 1 and disabled states', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(createForm({enabled: true, uotVersion: '1'}).udp_over_tcp)), {enabled: true, version: 1});
  assert.equal('udp_over_tcp' in createForm({enabled: false}), false);
  assert.throws(() => createForm({enabled: true, socksVersion: '4'}), /SOCKS5/);
});
