import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as core from '@iwsdk/core';
import { createGrabPointer, createRayPointer } from '@pmndrs/pointer-events';
import { intersectPointerEventTargets } from '../node_modules/@pmndrs/pointer-events/dist/intersections/utils.js';

// Run the application TypeScript in memory. Only canvas drawing and XR input
// hardware are stubbed; ECS queries, grab handles and resource disposal are real.
const context2d = new Proxy({}, {
  get: (_, key) => key === 'measureText'
    ? (text) => ({ width: text.length * 18 })
    : () => {},
});
const document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => context2d }),
};
const modules = new Map();
function loadModule(name) {
  if (modules.has(name)) return modules.get(name);
  const exports = {};
  modules.set(name, exports);
  const source = readFileSync(new URL('../src/' + name.replace('.js', '.ts'), import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  vm.runInNewContext(outputText, {
    exports, document, console, performance,
    require: (id) => id === '@iwsdk/core' ? core : loadModule(id.replace('./', '')),
  }, { filename: fileURLToPath(new URL('../src/' + name, import.meta.url)) });
  return exports;
}
const { TriageSystem } = loadModule('triage.js');
const { HandPinchSystem } = loadModule('hand-pinch.js');
const { EmailCard, CardState } = loadModule('email-card.js');

function setup() {
  const world = new core.World();
  world.registerComponent(core.Hovered).registerComponent(core.Pressed);
  world.scene = new core.Scene();
  world.sceneEntity = world.createTransformEntity(world.scene);
  world.camera = new core.PerspectiveCamera();
  world.renderer = { xr: new core.EventDispatcher() };
  world.player = {
    head: new core.Object3D(),
    gripSpaces: { left: new core.Object3D(), right: new core.Object3D() },
  };
  world.player.head.position.set(2, 1.6, 3);
  world.player.head.rotation.y = Math.PI / 3;
  const pointer = (id) => ({ toggleSubPointer() {}, getPointer: () => ({ id }) });
  world.input = { update() {}, xr: {
    multiPointers: { left: pointer(1), right: pointer(2) },
    gazePointer: { pointer: { id: 3 }, getHeldByHand: () => null },
    isPrimary: () => false,
    gamepads: {},
    getPrimaryInputSource: () => undefined,
  } };
  world.registerSystem(core.InputSystem, { priority: -4, configData: { maintainScenePointers: true } });
  world.registerSystem(HandPinchSystem, { priority: -3.5 });
  world.registerSystem(core.GrabSystem, { priority: -3 });
  world.registerSystem(TriageSystem);
  world.update(1 / 60, 0);
  return { world, system: world.getSystem(TriageSystem) };
}

function grab(world, entity) {
  const root = entity.object3D;
  let time = 0;
  const event = {
    pointerId: 2,
    point: root.getWorldPosition(new core.Vector3()),
    pointerPosition: new core.Vector3(),
    pointerQuaternion: new core.Quaternion(),
    details: { type: 'sphere' },
    intersection: { details: { type: 'sphere' } },
    object: { setPointerCapture() {}, releasePointerCapture() {} },
    stopPropagation() {},
  };
  function dispatch(type, point = event.point) {
    time += 16;
    root.dispatchEvent({ ...event, type, point, timeStamp: time });
    world.update(1 / 60, time / 1000);
  }
  dispatch('pointerdown');
  return {
    moveTo: (point) => dispatch('pointermove', point),
    release: () => dispatch('pointerup'),
  };
}

function pointerTargets(root) {
  const targets = [];
  intersectPointerEventTargets('pointer', root, [{
    type: 'grab', id: 2,
    options: {},
    intersector: { executeIntersection: (object) => targets.push(object) },
  }]);
  return targets;
}

test('card lifecycle against IWSDK', async (t) => {
  const { world, system } = setup();
  const entity = system.slots[0];
  const root = entity.object3D;
  const mesh = root.isMesh ? root : root.children[0];

  await t.test('expanded appearance survives handle updates and repeated grabs', () => {
    for (let i = 0; i < 2; i++) {
      const hand = grab(world, entity);
      assert.equal(entity.getValue(EmailCard, 'state'), CardState.Held);
      const destination = root.getWorldPosition(new core.Vector3()).add(new core.Vector3(0.05, 0, 0));
      hand.moveTo(destination);
      const scale = mesh.getWorldScale(new core.Vector3());
      assert.ok(Math.abs(scale.x * 0.36 - 0.46 * 1.3) < 1e-6);
      assert.ok(Math.abs(scale.y * 0.24 - 0.64 * 1.3) < 1e-6);
      assert.ok(root.position.distanceTo(destination) < 1e-6);
      hand.release();
      assert.equal(entity.getValue(EmailCard, 'state'), CardState.Returning);
      assert.deepEqual(mesh.scale.toArray(), [1, 1, 1]);
    }
    world.update(1, 2);
    assert.equal(entity.getValue(EmailCard, 'state'), CardState.Queued);
    const home = entity.getVectorView(EmailCard, 'homePosition');
    assert.ok(root.position.distanceTo(new core.Vector3(...home)) < 1e-6);
  });

  let faceDisposals = 0;
  let expandedDisposals = 0;
  let materialDisposals = 0;
  let geometryDisposals = 0;
  const runtime = system.runtime.get(entity);
  runtime.faceTex.addEventListener('dispose', () => faceDisposals++);
  runtime.expandedTex.addEventListener('dispose', () => expandedDisposals++);
  runtime.mat.addEventListener('dispose', () => materialDisposals++);
  mesh.geometry.addEventListener('dispose', () => geometryDisposals++);

  await t.test('dismissal disables targeting and ignores repeated lifecycle events', () => {
    assert.ok(pointerTargets(root).includes(mesh));
    const hand = grab(world, entity);
    hand.moveTo(system.binPos.clone());
    hand.release();
    assert.equal(entity.getValue(EmailCard, 'state'), CardState.Dismissed);
    assert.equal(system.remaining, 14);
    assert.equal(pointerTargets(root).length, 0);
    system.onGrab(entity);
    system.onRelease(entity);
    system.beginDismiss(entity, runtime);
    assert.equal(entity.getValue(EmailCard, 'state'), CardState.Dismissed);
    assert.equal(system.remaining, 14);
    assert.equal(runtime.dismissSlot, 0);
  });

  await t.test('dismissal disposes both textures exactly once and refills at the anchor', () => {
    world.update(0.6, 3);
    assert.ok(root.parent === null, 'dismissed card should leave the scene');
    assert.equal(faceDisposals, 1);
    assert.equal(expandedDisposals, 1);
    assert.equal(materialDisposals, 1);
    assert.equal(geometryDisposals, 1);
    const replacement = system.slots[0];
    assert.ok(replacement);
    assert.equal(replacement.getValue(EmailCard, 'emailIndex'), 5);
    const home = replacement.getVectorView(EmailCard, 'homePosition');
    const expected = new core.Vector3(-0.6, -0.28, -1.05)
      .applyQuaternion(system.anchorYawQ).add(system.anchorPos);
    assert.ok(replacement.object3D.position.distanceTo(expected) < 1e-6);
    assert.ok(new core.Vector3(...home).distanceTo(expected) < 1e-6);
    assert.equal(system.remaining, 14);
  });

  await t.test('external disposal also releases the inactive texture', () => {
    const other = system.slots[1];
    const rt = system.runtime.get(other);
    let disposed = 0;
    rt.faceTex.addEventListener('dispose', () => disposed++);
    rt.expandedTex.addEventListener('dispose', () => disposed++);
    other.dispose();
    assert.equal(disposed, 2);
    assert.equal(system.runtime.has(other), false);
  });
  await t.test('native hands without a gamepad can pinch, drag and release', () => {
    const source = { hand: {}, handedness: 'right', gamepad: null };
    const session = new EventTarget();
    world.session = session;
    world.renderer.xr.dispatchEvent({ type: 'sessionstart' });
    const card = system.slots[2];
    const root = card.object3D;
    const origin = new core.Object3D();
    origin.position.copy(root.position);
    const pointer = createGrabPointer(() => world.camera, { current: origin }, {});
    const xr = world.input.xr;
    const previousMulti = xr.multiPointers.right;
    xr.isPrimary = (kind, hand) => kind === 'hand' && hand === 'right';
    xr.getPrimaryInputSource = () => source;
    xr.multiPointers.right = {
      getActivePointer: () => pointer,
      getPointer: () => pointer,
      routeDown: (_, __, event) => pointer.down({ ...event, button: 2 }),
      routeUp: (_, __, event) => pointer.up({ ...event, button: 2 }),
    };
    function select(type) {
      const event = new Event(type);
      Object.defineProperty(event, 'inputSource', { value: source });
      session.dispatchEvent(event);
    }
    function frame() {
      origin.updateMatrix();
      pointer.move(world.scene, { timeStamp: performance.now() });
      world.update(1 / 60, performance.now() / 1000);
    }
    frame();
    assert.ok(!pointer.getIntersection().object.isVoidObject);
    select('selectstart');
    frame();
    assert.equal(card.getValue(EmailCard, 'state'), CardState.Held);
    assert.equal(system.runtime.get(card).lastHand, 'right');
    const before = root.position.clone();
    origin.position.x += 0.1;
    frame();
    assert.ok(root.position.x > before.x + 0.09);
    select('selectend');
    frame();
    assert.equal(card.getValue(EmailCard, 'state'), CardState.Returning);

    // Both native edges may arrive between rendered frames.
    origin.position.copy(root.position);
    frame();
    select('selectstart');
    select('selectend');
    frame();
    assert.equal(card.getValue(EmailCard, 'state'), CardState.Held);
    frame();
    assert.equal(card.getValue(EmailCard, 'state'), CardState.Returning);

    let exits = 0;
    world.exitXR = () => { exits++; };
    origin.position.copy(system.exitMesh.position);
    frame();
    select('selectstart');
    frame();
    assert.equal(exits, 1, 'EXIT must be observed without an EmailCard component');
    select('selectend');
    frame();
    world.session = undefined;
    world.renderer.xr.dispatchEvent({ type: 'sessionend' });
    xr.multiPointers.right = previousMulti;
    xr.getPrimaryInputSource = () => undefined;
    xr.isPrimary = () => false;
  });

  await t.test('ray pinches can grab cards and activate EXIT', () => {
    const origin = new core.PerspectiveCamera();
    origin.position.copy(system.anchorPos);
    const pointer = createRayPointer(() => world.camera, { current: origin }, {});
    const card = system.slots[3];
    origin.lookAt(card.object3D.position);
    origin.updateMatrix();
    pointer.move(world.scene, { timeStamp: 1000 });
    assert.ok(!pointer.getIntersection().object.isVoidObject);
    pointer.down({ button: 0, timeStamp: 1010 });
    world.update(1 / 60, 1.01);
    assert.equal(card.getValue(EmailCard, 'state'), CardState.Held);
    pointer.up({ button: 0, timeStamp: 1020 });
    world.update(1 / 60, 1.02);
    assert.equal(card.getValue(EmailCard, 'state'), CardState.Queued);

    let exits = 0;
    world.exitXR = () => { exits++; };
    origin.lookAt(system.exitMesh.position);
    origin.updateMatrix();
    pointer.move(world.scene, { timeStamp: 1030 });
    pointer.down({ button: 0, timeStamp: 1040 });
    world.update(1 / 60, 1.04);
    assert.equal(exits, 1);
    pointer.up({ button: 0, timeStamp: 1050 });
    world.update(1 / 60, 1.05);
  });

});
