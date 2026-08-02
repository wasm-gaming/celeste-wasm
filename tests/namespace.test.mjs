import assert from 'node:assert/strict';
import test from 'node:test';

// Which OPFS layout `load()` stages into. It is decided from two things — what
// the host set and what the runtime was built with — and getting it wrong is
// expensive in a way nothing else here is: the game is staged somewhere the
// loader never looks, 1.1 GB at a time, and only says so at the end.
//
// It is also the rule the deployed site got wrong. The default asked for a
// namespace; the runtime CI ships is the downloaded one, which has none.
const { resolveStorageNamespace } = await import('../dist/celeste/celeste.runtime.js');

const STOCK = { builtFromSource: false, storageNamespace: null };
const NAMESPACED = { builtFromSource: true, storageNamespace: 'celeste' };

// ------------------------------------------------------- the host says nothing

test('an unset namespace follows the runtime', () => {
  assert.equal(resolveStorageNamespace(undefined, STOCK), '');
  assert.equal(resolveStorageNamespace(undefined, NAMESPACED), 'celeste');
});

test('a descriptor with no namespace field is the mount root', () => {
  assert.equal(resolveStorageNamespace(undefined, { revision: 'abc' }), '');
});

test('an unset namespace with no descriptor falls back', () => {
  assert.equal(resolveStorageNamespace(undefined, null), '');
  assert.equal(resolveStorageNamespace(undefined, null, 'celeste'), 'celeste');
});

// The fallback answers only for a runtime that said nothing. A runtime that did
// say something outranks it — otherwise a host configured for one engine layout
// would drag every runtime it boots into that layout.
test('the fallback does not override a runtime that answered', () => {
  assert.equal(resolveStorageNamespace(undefined, STOCK, 'celeste'), '');
});

// ---------------------------------------------------------- the host insists

test('a namespace the runtime agrees with is kept', () => {
  assert.equal(resolveStorageNamespace('', STOCK), '');
  assert.equal(resolveStorageNamespace('celeste', NAMESPACED), 'celeste');
});

test('asking a stock runtime for a namespace is refused, and says how to fix it', () => {
  assert.throws(() => resolveStorageNamespace('celeste', STOCK), (error) => {
    assert.match(error.message, /storageNamespace is "celeste"/);
    assert.match(error.message, /root of the origin private filesystem/);
    assert.match(error.message, /Set storageNamespace to ""/);
    assert.match(error.message, /LOADER_NAMESPACE=celeste/);
    return true;
  });
});

test('asking a namespaced runtime for the root is refused too', () => {
  assert.throws(() => resolveStorageNamespace('', NAMESPACED), (error) => {
    assert.match(error.message, /keeps the game under "celeste"/);
    assert.match(error.message, /LOADER_NAMESPACE=-/);
    return true;
  });
});

// A CDN copy of `_framework/` may not carry the file, and refusing to boot over
// missing metadata would be worse than the mismatch it guards against.
test('a runtime with no descriptor is trusted', () => {
  assert.equal(resolveStorageNamespace('celeste', null), 'celeste');
  assert.equal(resolveStorageNamespace('', null), '');
});
