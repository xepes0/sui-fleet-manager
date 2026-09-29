const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('web/app.js', 'utf8');
const formSource = source.slice(source.indexOf('function requiredValue('), source.indexOf('function buildClient('));
const templateSource = fs.readFileSync('web/templates.js', 'utf8');
const subscriptionExportSource = templateSource.slice(templateSource.indexOf('function subExportURL('), templateSource.indexOf('function subExportRender('));

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


test('bulk subscription export selects the requested format and enabled users', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(subscriptionExportSource, context);
  const results = [
    {
      server_id: 1,
      server: 'HK-1',
      clients: [
        {name:'alice', remark:'Alice', enabled:true, plain_url:'https://sub.example/a', json_url:'https://sub.example/a?format=json', clash_url:'https://sub.example/a?format=clash'},
        {name:'bob', remark:'Bob', enabled:false, plain_url:'https://sub.example/b', json_url:'https://sub.example/b?format=json', clash_url:'https://sub.example/b?format=clash'}
      ]
    },
    {
      server_id: 2,
      server: 'US-1',
      clients: [
        {name:'carol', enabled:true, plain_url:'https://sub2.example/c', json_url:'https://sub2.example/c?format=json', clash_url:'https://sub2.example/c?format=clash'}
      ]
    }
  ];
  const rows = vm.runInContext('subBuildExportRows', context)(results, 'json', true);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://sub.example/a?format=json');
  assert.equal(rows[1].url, 'https://sub2.example/c?format=json');
  assert.equal(vm.runInContext('subExportText', context)(rows), 'https://sub.example/a?format=json\nhttps://sub2.example/c?format=json\n');
});

test('bulk subscription export skips missing and duplicate URLs', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(subscriptionExportSource, context);
  const results = [
    {server_id:1,server:'one',clients:[
      {name:'a',enabled:true,plain_url:'https://same.example/sub/a'},
      {name:'b',enabled:true,plain_url:''}
    ]},
    {server_id:2,server:'two',clients:[
      {name:'a2',enabled:true,plain_url:'https://same.example/sub/a'}
    ]},
    {server_id:3,server:'bad',error:'offline',clients:[]}
  ];
  const rows = vm.runInContext('subBuildExportRows', context)(results, 'plain', false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].server, 'one');
});


test('subscription export groups links by username across servers', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(subscriptionExportSource, context);
  const rows = [
    {server_id:1,server:'HK-1',name:'alice',remark:'Alice',url:'https://one.example/alice'},
    {server_id:2,server:'US-1',name:'alice',remark:'Alice US',url:'https://two.example/alice'},
    {server_id:2,server:'US-1',name:'bob',remark:'Bob',url:'https://two.example/bob'}
  ];
  const groups = vm.runInContext('subGroupExportRows', context)(rows);
  assert.equal(groups.length, 2);
  const alice = groups.find(group => group.name === 'alice');
  assert.equal(alice.server_count, 2);
  assert.equal(alice.link_count, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(alice.servers.sort())), [1,2]);
  assert.equal(groups.find(group => group.name === 'bob').link_count, 1);
});

test('username grouping keeps distinct usernames separate even with the same remark', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(subscriptionExportSource, context);
  const rows = [
    {server_id:1,server:'one',name:'user-a',remark:'Shared',url:'https://one.example/a'},
    {server_id:2,server:'two',name:'user-b',remark:'Shared',url:'https://two.example/b'}
  ];
  const groups = vm.runInContext('subGroupExportRows', context)(rows);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(group => group.name).sort())), ['user-a','user-b']);
});
