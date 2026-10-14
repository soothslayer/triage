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
  activeElement: null,
  body: { children: [], appendChild(element) { this.children.push(element); } },
  createElement: (tag) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: () => context2d }
    : {
      tagName: tag, value: '', style: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { document.activeElement = this; },
      blur() { if (document.activeElement === this) document.activeElement = null; this.onblur?.(); },
      remove() { document.body.children = document.body.children.filter((child) => child !== this); },
    },
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
    exports, document, console, performance, setTimeout, clearTimeout,
    require: (id) => id === '@iwsdk/core' ? core : loadModule(id.replace('./', '')),
  }, { filename: fileURLToPath(new URL('../src/' + name, import.meta.url)) });
  return exports;
}
const { TriageSystem } = loadModule('triage.js');
const { HandPinchSystem } = loadModule('hand-pinch.js');
const { EmailCard, CardState } = loadModule('email-card.js');
const { SampleMail } = loadModule('sample-mail.js');
const { MOCK_INBOX } = loadModule('mockInbox.js');

function setup() {
  const world = new core.World();
  world.registerComponent(core.Hovered).registerComponent(core.Pressed);
  world.scene = new core.Scene();
  world.sceneEntity = world.createTransformEntity(world.scene);
  world.camera = new core.PerspectiveCamera();
  world.renderer = { xr: new core.EventDispatcher() };
  world.renderer.xr.getFrame = () => null;
  world.renderer.xr.getReferenceSpace = () => null;
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

  await t.test('UNDO restores a replaced card and preserves queue order', () => {
    assert.equal(system.lastAction.entity, null, 'disposed entities must not remain in history');
    const queueBefore = [...system.queue];
    const held = grab(world, system.slots[2]);
    assert.equal(pointerTargets(system.undoMesh).length, 0, 'disabled while another card is held');
    system.undoLastAction();
    assert.equal(system.remaining, 14);
    held.release();
    assert.ok(pointerTargets(system.undoMesh).includes(system.undoMesh));
    const undo = grab(world, system.undoEntity);
    undo.release();
    assert.equal(system.remaining, 15);
    assert.equal(system.slots[0].getValue(EmailCard, 'emailIndex'), 0);
    assert.deepEqual([...system.queue], [5, ...queueBefore]);
    assert.equal(system.lastAction, null);
    assert.equal(pointerTargets(system.undoMesh).length, 0);
    system.undoLastAction();
    assert.equal(system.remaining, 15, 'cannot undo the same action twice');
  });

  await t.test('4 cm swipes in either facing-relative direction tolerate a delayed release and undo during fade', () => {
    const card = system.slots[0];
    const originalQueue = [...system.queue];
    const right = new core.Vector3(1, 0, 0).applyQuaternion(system.anchorYawQ);
    for (const direction of [1, -1]) {
      const hand = grab(world, card);
      const initial = world.player.gripSpaces.right.position.clone();
      for (let step = 1; step <= 6; step++) {
        world.player.gripSpaces.right.position.copy(initial).addScaledVector(right, direction * 0.04 * step / 6);
        world.update(1 / 60, 0);
      }
      const rt = system.runtime.get(card);
      assert.equal(rt.swipe.getDirection(system.elapsed), direction);
      assert.equal(rt.mat.color.getHex(), direction > 0 ? 0xaaffcc : 0xffaaaa);
      for (let i = 0; i < 6; i++) world.update(1 / 60, 0);
      hand.release();
      assert.equal(card.getValue(EmailCard, 'state'), CardState.Dismissed);
      assert.equal(system.remaining, 14);
      assert.ok(rt.dismissVel.dot(right) * direction > 2);
      assert.equal(rt.mat.color.getHex(), 0xffffff);
      const undo = grab(world, system.undoEntity);
      undo.release();
      assert.equal(system.slots[0], card, 'restore the still-live card');
      assert.equal(card.getValue(EmailCard, 'state'), CardState.Queued);
      assert.equal(system.remaining, 15);
      assert.equal(rt.mat.opacity, 1);
      assert.ok(pointerTargets(card.object3D).includes(rt.mesh));
      assert.ok(card.object3D.position.distanceTo(new core.Vector3(...card.getVectorView(EmailCard, 'homePosition'))) < 1e-6);
      world.update(0.6, 0);
      assert.equal(system.slots[0], card, 'cancel the pending disposal and refill');
      assert.deepEqual([...system.queue], originalQueue);
    }
  });

  await t.test('TODAY wins over an armed swipe, and is undoable', () => {
    const card = system.slots[0];
    const hand = grab(world, card);
    const rt = system.runtime.get(card);
    const start = world.player.gripSpaces.right.position.clone();
    const right = new core.Vector3(0.04, 0, 0).applyQuaternion(system.anchorYawQ);
    world.player.gripSpaces.right.position.add(right);
    world.update(0.08, 0);
    assert.equal(rt.swipe.getDirection(system.elapsed), 1);
    hand.moveTo(system.binPos.clone());
    hand.release();
    assert.equal(card.getValue(EmailCard, 'state'), CardState.Dismissed);
    assert.ok(rt.dismissVel.length() <= 1, 'use the bin animation rather than the sideways throw');
    system.undoLastAction();
    assert.equal(system.remaining, 15);
    world.player.gripSpaces.right.position.copy(start);
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
    system.dealIntoSlot(1, 1);
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

  await t.test('the final dismissal can be undone after the inbox-zero overlay appears', () => {
    let finalEmail;
    let finalSlot;
    while (system.remaining > 0) {
      const card = system.slots.find(Boolean);
      assert.ok(card);
      finalEmail = card.getValue(EmailCard, 'emailIndex');
      finalSlot = card.getValue(EmailCard, 'slotIndex');
      system.beginDismiss(card, system.runtime.get(card));
      world.update(0.6, 0);
    }
    assert.equal(system.zeroMesh.visible, true);
    const undo = grab(world, system.undoEntity);
    undo.release();
    assert.equal(system.remaining, 1);
    assert.equal(system.zeroMesh.visible, false);
    assert.equal(system.slots[finalSlot].getValue(EmailCard, 'emailIndex'), finalEmail);
    assert.equal(system.queue.length, 0);
  });

});


test('short swipe classifier rejects incidental movement and expires old gestures', () => {
  const { SwipeTracker } = loadModule('swipe.js');
  const swipe = new SwipeTracker();
  const yaw = new core.Quaternion().setFromAxisAngle(new core.Vector3(0, 1, 0), Math.PI * 0.8);
  const position = (x, y = 0, z = 0) => new core.Vector3(x, y, z).applyQuaternion(yaw);
  for (const direction of [-1, 1]) {
    swipe.reset(position(0), yaw, 0);
    for (let i = 1; i <= 6; i++) swipe.add(position(direction * 0.04 * i / 6), i / 60);
    assert.equal(swipe.getDirection(0.1), direction);
    assert.equal(swipe.getDirection(0.23), direction, 'release shortly after stopping');
    assert.equal(swipe.getDirection(0.3), 0, 'old motion cannot dismiss later');
  }
  for (const motion of [
    (i) => position(i % 2 ? 0.006 : -0.006), // Tracking jitter.
    (i) => position(i * 0.0015), // Slow repositioning, eventually over 3 cm.
    (i) => position(i * 0.006, i * 0.009), // Mostly vertical.
    (i) => position(i * 0.006, 0, i * 0.009), // Mostly depth.
  ]) {
    swipe.reset(position(0), yaw, 0);
    for (let i = 1; i <= 60; i++) {
      swipe.add(motion(i), i / 60);
      assert.equal(swipe.getDirection(i / 60), 0);
    }
  }
  swipe.reset(position(0), yaw, 0);
  swipe.add(position(0.04), 0.08);
  assert.equal(swipe.getDirection(0.08), 1);
  swipe.add(position(0.02), 0.1);
  assert.equal(swipe.getDirection(0.1), 0, 'reversing cancels the armed direction');
  swipe.reset(position(0), yaw, 0.11);
  assert.equal(swipe.getDirection(0.11), 0, 'new grab starts without old momentum');
});

test('sample composer validates, quotes messages, cancels, and sends exactly once', () => {
  const mail = new SampleMail(MOCK_INBOX);
  assert.equal(mail.begin('reply'), false, 'a source message is required');
  mail.select('m1');
  assert.equal(mail.begin('reply'), true);
  assert.equal(mail.draft.to, MOCK_INBOX[0].senderAddress);
  assert.equal(mail.draft.subject, MOCK_INBOX[0].subject, 'do not duplicate Re:');
  assert.equal(mail.send().field, 'message');
  assert.equal(mail.sent.length, 0);
  const reply = mail.draft;
  reply.message = '  I will pick up the cake.\nSee you Saturday!  ';
  mail.select('m2');
  assert.equal(mail.selectedId, 'm1', 'source stays fixed while editing');
  assert.equal(mail.begin('forward'), false, 'do not overwrite a draft');
  reply.to = 'wrong@example.com';
  assert.equal(mail.send(), null);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, MOCK_INBOX[0].senderAddress, 'reply targets the source sender');
  assert.equal(mail.sent[0].sourceId, 'm1');
  assert.ok(mail.sent[0].body.startsWith('I will pick up the cake.\nSee you Saturday!\n\n'));
  assert.ok(mail.sent[0].body.endsWith(MOCK_INBOX[0].body));
  assert.match(mail.status, /No email was sent/);
  mail.send();
  assert.equal(mail.sent.length, 1, 'duplicate submission cannot resend');
  assert.equal(mail.inbox.length, 15, 'sending is not an archive action');

  mail.select('m2');
  mail.begin('forward');
  assert.equal(mail.draft.subject, `Fwd: ${MOCK_INBOX[1].subject}`);
  for (const address of ['', 'friend', 'a@example.com,b@example.com', 'a@b@example.com']) {
    mail.draft.to = address;
    assert.equal(mail.send().field, 'to');
    assert.equal(mail.sent.length, 1);
  }
  mail.draft.to = ' friend@example.com ';
  mail.draft.subject = ' ';
  assert.equal(mail.send().field, 'subject');
  mail.draft.subject = 'For our call';
  assert.equal(mail.send(), null, 'forward can send just the original message');
  assert.equal(mail.sent[1].to, 'friend@example.com');
  assert.match(mail.sent[1].body, /Forwarded message/);
  assert.ok(mail.sent[1].body.includes(MOCK_INBOX[1].body));

  mail.begin('reply');
  assert.equal(mail.draft.subject, `Re: ${MOCK_INBOX[1].subject}`);
  mail.draft.message = 'discard me';
  mail.cancel();
  assert.equal(mail.draft, null);
  assert.equal(mail.sent.length, 2);
  mail.begin('reply');
  assert.equal(mail.draft.message, '', 'cancel discards the old text');
  mail.cancel();
  mail.setAvailable('m2', false);
  assert.equal(mail.selected, undefined);
  assert.equal(mail.begin('reply'), false, 'dismissed selections cannot be replied to accidentally');
  mail.setAvailable('m2', true);
  assert.equal(mail.inbox.length, 15);
  assert.equal(new SampleMail(MOCK_INBOX).sent.length, 0, 'sent sample mail is session-only');
});

test('spatial Reply and Forward preserve cards and support near and ray pinches', () => {
  const { world, system } = setup();
  assert.equal(pointerTargets(system.replyMesh).length, 0, 'disabled without a selection');
  const card = system.slots[0];
  const hand = grab(world, card);
  assert.equal(system.mail.selectedId, 'm1');
  assert.equal(system.composeSelection('reply'), false, 'never exit XR with a card held');
  assert.equal(pointerTargets(system.replyMesh).length, 0);
  hand.release();
  assert.ok(pointerTargets(system.replyMesh).includes(system.replyMesh));
  let exits = 0;
  world.session = new EventTarget();
  world.exitXR = () => { exits++; };
  const reply = grab(world, system.replyEntity);
  reply.release();
  assert.equal(exits, 0, 'composition keeps XR active');
  assert.equal(system.composer.root.visible, true);
  assert.equal(system.mail.draft.mode, 'reply');
  assert.equal(system.mail.draft.source.id, 'm1');
  assert.equal(system.remaining, 15);
  assert.equal(system.lastAction, null);
  assert.equal(system.composeSelection('forward'), false, 'one draft at a time');
  system.mail.cancel();
  world.update(1 / 60, 2);

  const origin = new core.PerspectiveCamera();
  origin.position.copy(system.anchorPos);
  origin.lookAt(system.forwardMesh.position);
  origin.updateMatrix();
  const pointer = createRayPointer(() => world.camera, { current: origin }, {});
  pointer.move(world.scene, { timeStamp: 2000 });
  pointer.down({ button: 0, timeStamp: 2010 });
  world.update(1 / 60, 2.01);
  pointer.up({ button: 0, timeStamp: 2020 });
  world.update(1 / 60, 2.02);
  assert.equal(system.mail.draft?.mode, 'forward');
  assert.equal(exits, 0, 'forward also keeps XR active');
  system.mail.draft.to = 'friend@example.com';
  system.mail.draft.message = 'Take a look.';
  system.mail.send();
  assert.equal(system.remaining, 15);
  assert.equal(system.mail.sent.length, 1);
  assert.equal(system.slots[0], card);

  system.beginDismiss(card, system.runtime.get(card));
  assert.equal(system.mail.selectedId, null);
  assert.equal(system.mail.inbox.length, 14);
  assert.equal(pointerTargets(system.forwardMesh).length, 0);
  system.undoLastAction();
  assert.equal(system.mail.inbox.length, 15);
  assert.equal(system.remaining, 15);
  assert.equal(system.mail.sent.length, 1, 'UNDO concerns triage, not sample sent messages');
});

test('four-way flicks require axis dominance, speed and distance', () => {
  const { SwipeTracker } = loadModule('swipe.js');
  const swipe = new SwipeTracker();
  const yaw = new core.Quaternion().setFromAxisAngle(new core.Vector3(0, 1, 0), 1.8);
  const position = (x, y, z = 0) => new core.Vector3(x, y, z).applyQuaternion(yaw);
  for (const [x, y, expected] of [[.04, 0, 'right'], [-.04, 0, 'left'], [0, .04, 'up'], [0, -.04, 'down']]) {
    swipe.reset(position(0, 0), yaw, 0);
    for (let i = 1; i <= 6; i++) swipe.add(position(x * i / 6, y * i / 6), i / 60);
    assert.equal(swipe.getFlick(.1), expected);
    assert.equal(swipe.getFlick(.23), expected);
    assert.equal(swipe.getFlick(.3), null);
    swipe.reset(position(0, 0), yaw, .4);
    assert.equal(swipe.getFlick(.4), null);
  }
  for (const motion of [
    (i) => position(i * .006, i * .006), // Ambiguous diagonal.
    (i) => position(0, i * .0015), // Slow lift.
    (i) => position(0, i % 2 ? .006 : -.006), // Jitter.
    (i) => position(0, i * .006, i * .009), // Depth dominant.
  ]) {
    swipe.reset(position(0, 0), yaw, 0);
    for (let i = 1; i <= 60; i++) {
      swipe.add(motion(i), i / 60);
      assert.equal(swipe.getFlick(i / 60), null);
    }
  }
  swipe.reset(position(0, 0), yaw, 0);
  swipe.add(position(0, .04), .08);
  assert.equal(swipe.getFlick(.08), 'up');
  swipe.add(position(0, .02), .1);
  assert.equal(swipe.getFlick(.1), null, 'vertical reversal cancels the gesture');
});

test('vertical card flicks open the correct immersive composer without consuming the card', () => {
  const { world, system } = setup();
  world.session = new EventTarget();
  let exits = 0;
  world.exitXR = () => { exits++; };
  const card = system.slots[2];
  for (const [sign, mode] of [[1, 'reply'], [-1, 'forward']]) {
    const hand = grab(world, card);
    const initial = world.player.gripSpaces.right.position.clone();
    for (let i = 1; i <= 6; i++) {
      world.player.gripSpaces.right.position.copy(initial).add(new core.Vector3(0, sign * .04 * i / 6, 0));
      world.update(1 / 60, 0);
    }
    assert.equal(system.runtime.get(card).mat.color.getHex(), sign > 0 ? 0xaacfff : 0xe3b0ff);
    hand.release();
    assert.equal(system.mail.draft.mode, mode);
    assert.equal(system.mail.draft.source.id, 'm3');
    assert.equal(system.composer.root.visible, true);
    assert.equal(system.composer.original.mesh.visible, true, 'original remains readable');
    assert.equal(system.remaining, 15);
    assert.equal(system.slots[2], card);
    assert.equal(system.lastAction, null);
    world.update(1 / 60, 0);
    assert.equal(pointerTargets(card.object3D).length, 0, 'background triage is suspended');
    const cancel = system.composer.buttons.find((b) => b.label === 'Cancel');
    grab(world, cancel.entity).release();
    assert.equal(system.mail.draft, null);
    assert.equal(system.composer.root.visible, false);
    assert.equal(system.remaining, 15);
  }
  const hand = grab(world, card);
  world.player.gripSpaces.right.position.y += .04;
  world.update(.08, 0);
  hand.moveTo(system.binPos.clone());
  hand.release();
  assert.equal(card.getValue(EmailCard, 'state'), CardState.Dismissed, 'TODAY wins over vertical flicks');
  assert.equal(system.mail.draft, null);
  system.undoLastAction();
  assert.equal(system.remaining, 15);
  assert.equal(exits, 0);
});

test('spatial controls request the native keyboard, preserve existing text, and keep XR active', () => {
  const { world, system } = setup();
  world.session = new EventTarget();
  world.session.isSystemKeyboardSupported = true;
  world.session.visibilityState = 'visible';
  const card = system.slots[0];
  grab(world, card).release();
  system.composeSelection('forward');
  const composer = system.composer;
  assert.equal(composer.keyboard.active, true, 'keyboard opens automatically on entry');
  const initialInput = document.activeElement;
  assert.equal(initialInput.attributes['data-triage-system-keyboard'], 'to');
  world.update(1 / 60, 0);
  assert.equal(document.activeElement, initialInput, 'frames preserve the same editing session');
  initialInput.blur();
  world.update(1 / 60, 0);
  assert.equal(composer.keyboard.active, false, 'dismissal does not reopen the keyboard');
  assert.equal(composer.buttons.some((b) => b.label === 'q' || b.label === 'Shift'), false, 'no custom keys');
  const press = (label) => {
    const button = composer.buttons.find((b) => b.label === label);
    assert.ok(button, label);
    grab(world, button.entity).release();
  };
  // Real SDK ray interaction activates the native keyboard bridge.
  const keyboard = composer.buttons.find((b) => b.label === 'Horizon keyboard');
  const origin = new core.PerspectiveCamera();
  origin.position.copy(system.anchorPos);
  origin.lookAt(keyboard.mesh.getWorldPosition(new core.Vector3()));
  origin.updateMatrix();
  const pointer = createRayPointer(() => world.camera, { current: origin }, {});
  pointer.move(world.scene, { timeStamp: 4000 });
  pointer.down({ button: 0, timeStamp: 4010 });
  world.update(1 / 60, 4.01);
  pointer.up({ button: 0, timeStamp: 4020 });
  world.update(1 / 60, 4.02);
  assert.equal(composer.keyboard.active, true);
  const input = document.activeElement;
  assert.equal(input.value, '');
  input.value = 'friend@example.com'; input.oninput();
  assert.equal(system.mail.draft.to, 'friend@example.com');
  input.blur();
  assert.equal(document.body.children.length, 0);
  press('message');
  press('Horizon keyboard');
  const text = document.activeElement;
  assert.equal(text.tagName, 'textarea');
  text.value = 'Hello'; text.oninput();
  text.value = 'Hello there.\nCan you join?'; text.oninput();
  assert.equal(system.mail.draft.message, 'Hello there.\nCan you join?');
  assert.equal(pointerTargets(composer.buttons.find((b) => b.label === 'Simulate send').mesh).length, 0);
  // OS keyboard focus must not trigger buttons behind it.
  world.session.visibilityState = 'visible-blurred';
  world.session.dispatchEvent(new Event('visibilitychange'));
  assert.equal(composer.keyboard.active, true);
  assert.equal(composer.root.visible, true);
  composer.activate(composer.buttons.find((b) => b.label === 'Cancel').entity);
  assert.ok(system.mail.draft);
  text.blur();
  world.session.visibilityState = 'visible';
  press('Horizon keyboard');
  const more = document.activeElement;
  assert.equal(more.value, '', 'new native edit starts with its own buffer');
  more.value = 'Thanks!'; more.oninput(); more.blur();
  assert.equal(system.mail.draft.message, 'Hello there.\nCan you join? Thanks!');
  press('Undo edit');
  assert.equal(system.mail.draft.message, 'Hello there.\nCan you join?');
  press('Add / Replace'); press('Horizon keyboard');
  const replace = document.activeElement;
  assert.equal(system.mail.draft.message, 'Hello there.\nCan you join?', 'opening replace does not erase');
  replace.value = 'Revised message'; replace.oninput(); replace.blur();
  assert.equal(system.mail.draft.message, 'Revised message');
  press('Undo edit');
  assert.equal(system.mail.draft.message, 'Hello there.\nCan you join?');
  const shortMessage = system.mail.draft.message;
  system.mail.edit({ message: Array.from({ length: 20 }, (_, i) => `Message line ${i}`).join('\n') });
  press('message');
  assert.ok(composer.renderedMessageStart > 0);
  press('Message ↑');
  assert.ok(composer.renderedMessageStart < composer.messageLines - 5);
  press('Message ↓');
  assert.equal(composer.renderedMessageStart, composer.messageLines - 5);
  system.mail.edit({ message: shortMessage });
  press('Simulate send');
  assert.equal(system.mail.sent.length, 1);
  assert.equal(system.mail.sent[0].to, 'friend@example.com');
  assert.ok(system.mail.sent[0].body.startsWith('Hello there.\nCan you join?'));
  assert.equal(system.mail.draft, null);
  assert.equal(system.remaining, 15);
  assert.ok(world.xrSession);
});

test('Back returns to triage, keeps separate drafts and opens the keyboard again on resume', () => {
  const { world, system } = setup();
  world.session = new EventTarget();
  world.session.isSystemKeyboardSupported = true;
  world.session.visibilityState = 'visible';
  const session = world.session;
  const card = system.slots[0];
  grab(world, card).release();
  system.composeSelection('reply');
  const composer = system.composer;
  const input = document.activeElement;
  assert.equal(input.attributes['data-triage-system-keyboard'], 'message');
  input.value = 'Keep this reply'; input.oninput(); input.blur();
  const back = composer.buttons.find((b) => b.label === '← Back');
  grab(world, back.entity).release();
  assert.equal(system.mail.draft, null);
  assert.equal(composer.root.visible, false);
  assert.equal(composer.keyboard.active, false);
  assert.equal(document.body.children.length, 0);
  assert.equal(system.mail.sent.length, 0);
  assert.equal(system.remaining, 15);
  assert.equal(world.xrSession, session);
  assert.ok(pointerTargets(card.object3D).length, 'cards can be selected after Back');
  system.composeSelection('forward');
  assert.equal(system.mail.draft.message, '', 'reply and forward have independent drafts');
  system.mail.edit({ to: 'friend@example.com', subject: 'A forward', message: 'Keep this forward' });
  composer.activate(back.entity);
  system.composeSelection('reply');
  assert.equal(system.mail.draft.message, 'Keep this reply');
  assert.equal(document.activeElement.attributes['data-triage-system-keyboard'], 'message');
  composer.activate(composer.buttons.find((b) => b.label === 'Cancel').entity);
  system.composeSelection('reply');
  assert.equal(system.mail.draft.message, '', 'Cancel discards the resumed draft');
  composer.activate(composer.buttons.find((b) => b.label === 'Cancel').entity);
  system.composeSelection('forward');
  assert.equal(system.mail.draft.to, 'friend@example.com');
  assert.equal(system.mail.draft.subject, 'A forward');
  assert.equal(system.mail.draft.message, 'Keep this forward');
  composer.activate(composer.buttons.find((b) => b.label === 'Cancel').entity);
});

test('native keyboard capability, cleanup, late events and focus failure never fall back to an overlay', () => {
  const { SystemKeyboard } = loadModule('system-keyboard.js');
  const keyboard = new SystemKeyboard(() => {});
  const session = new EventTarget();
  session.visibilityState = 'visible';
  keyboard.setSession(session);
  assert.equal(keyboard.open('message', () => assert.fail('must not edit')), false);
  assert.equal(document.body.children.length, 0);
  assert.match(keyboard.status, /unavailable/);
  session.isSystemKeyboardSupported = true;
  const values = [];
  assert.equal(keyboard.open('message', (value) => values.push(value)), true);
  const input = document.activeElement;
  const late = input.oninput;
  assert.match(input.style.cssText, /opacity:0/);
  assert.match(input.style.cssText, /position:fixed;left:0;top:0/);
  input.value = 'final on blur'; input.blur();
  assert.deepEqual(values, ['final on blur']);
  assert.equal(keyboard.active, false);
  late();
  assert.deepEqual(values, ['final on blur'], 'closed bridge ignores stale events');
  keyboard.open('to', (value) => values.push(value));
  session.visibilityState = 'hidden'; session.dispatchEvent(new Event('visibilitychange'));
  assert.equal(keyboard.active, false);
  session.visibilityState = 'visible';
  keyboard.open('to', () => {});
  session.dispatchEvent(new Event('end'));
  assert.equal(keyboard.active, false);
  assert.equal(document.body.children.length, 0);
  assert.equal(keyboard.supported, false);
  const originalCreate = document.createElement;
  document.createElement = (tag) => ({ ...originalCreate(tag), focus() { throw new Error('focus rejected'); } });
  try {
    keyboard.setSession(session);
    assert.equal(keyboard.open('to', () => {}), false);
    assert.equal(document.body.children.length, 0);
    assert.match(keyboard.status, /focus was rejected/);
  } finally { document.createElement = originalCreate; keyboard.dispose(); }
});

function speechHarness() {
  const instances = [];
  return {
    instances,
    factory: () => {
      const recognition = { startCalls: 0, stopCalls: 0, abortCalls: 0,
        start() { this.startCalls++; }, stop() { this.stopCalls++; }, abort() { this.abortCalls++; },
      };
      instances.push(recognition);
      return recognition;
    },
  };
}
function speechResult(text, final = true) {
  return { resultIndex: 0, results: [{ isFinal: final, 0: { transcript: text } }] };
}

test('voice only starts deliberately, commits finals once, stops before send, and rejects stale callbacks', () => {
  const { DraftEditor } = loadModule('draft-editor.js');
  const mail = new SampleMail(MOCK_INBOX);
  const { instances, factory } = speechHarness();
  const editor = new DraftEditor(mail, () => {}, factory);
  mail.select('m1'); mail.begin('reply');
  assert.equal(instances.length, 0, 'opening a draft does not request microphone access');
  editor.record();
  const recognition = instances[0];
  assert.equal(recognition.startCalls, 1);
  assert.equal(editor.voice.state, 'starting');
  recognition.onstart(); recognition.onaudiostart();
  assert.equal(editor.voice.state, 'listening');
  recognition.onresult(speechResult('hello', false));
  assert.equal(mail.draft.message, '');
  assert.equal(editor.voice.interim, 'hello');
  recognition.onresult(speechResult('Hello there.'));
  recognition.onresult(speechResult('Hello there.'));
  assert.equal(mail.draft.message, 'Hello there.', 'duplicate final events are not appended again');
  editor.send();
  assert.equal(mail.sent.length, 0);
  assert.match(editor.error, /Stop recording/);
  editor.record();
  assert.equal(recognition.stopCalls, 1);
  assert.equal(editor.voice.state, 'stopping');
  recognition.onend();
  assert.equal(editor.voice.state, 'idle');
  editor.record();
  const lateResult = instances[1].onresult;
  editor.cancel();
  assert.equal(instances[1].abortCalls, 1);
  mail.begin('reply');
  lateResult(speechResult('must not leak into a new draft'));
  assert.equal(mail.draft.message, '');
  editor.record();
  const keyboardInput = editor.beginKeyboard('append');
  assert.equal(instances[2].abortCalls, 1);
  keyboardInput('h'); keyboardInput('hi');
  editor.send();
  assert.equal(mail.sent.length, 1);
  assert.ok(mail.sent[0].body.startsWith('hi\n\n'));
  editor.dispose();
});

test('speech denial, unsupported browsers and service errors preserve editing and never fabricate dictation', () => {
  const { DraftEditor } = loadModule('draft-editor.js');
  const mail = new SampleMail(MOCK_INBOX);
  const { instances, factory } = speechHarness();
  const editor = new DraftEditor(mail, () => {}, factory);
  mail.select('m2'); mail.begin('forward');
  for (const error of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'no-speech', 'language-not-supported']) {
    editor.record();
    instances.at(-1).onerror({ error });
    assert.equal(editor.voice.state, 'error');
    assert.match(editor.voice.status, /Keyboard/);
    assert.equal(mail.draft.to, '');
    assert.equal(instances.at(-1).abortCalls, 1);
  }
  editor.record();
  const previous = instances.at(-1);
  const lateResult = previous.onresult;
  editor.focus('message');
  assert.equal(previous.abortCalls, 1, 'changing fields stops the old recording');
  lateResult(speechResult('wrong field'));
  assert.equal(mail.draft.message, '');
  editor.record();
  editor.dispose();
  assert.equal(instances.at(-1).abortCalls, 1, 'cleanup stops microphone');
  const unsupported = new DraftEditor(new SampleMail(MOCK_INBOX), () => {});
  assert.equal(unsupported.voice.state, 'unavailable');
  unsupported.dispose();
});

test('XR visibility changes and session end abort microphone without sending or losing the draft', () => {
  const { DraftEditor } = loadModule('draft-editor.js');
  const { world, system } = setup();
  const { instances, factory } = speechHarness();
  system.composer.editor.dispose();
  system.composer.editor = new DraftEditor(system.mail, () => system.composer.render(), factory);
  const session = new EventTarget();
  session.visibilityState = 'visible';
  world.session = session;
  world.renderer.xr.dispatchEvent({ type: 'sessionstart' });
  system.mail.select('m1');
  system.composeSelection('reply');
  const editor = system.composer.editor;
  editor.record();
  instances[0].onstart(); instances[0].onaudiostart();
  instances[0].onresult(speechResult('Keep this draft.'));
  session.visibilityState = 'visible-blurred';
  session.dispatchEvent(new Event('visibilitychange'));
  assert.equal(instances[0].abortCalls, 1);
  assert.equal(editor.voice.active, false);
  assert.equal(system.mail.draft.message, 'Keep this draft.');
  assert.equal(system.mail.sent.length, 0);
  session.visibilityState = 'visible';
  session.dispatchEvent(new Event('visibilitychange'));
  assert.equal(instances.length, 1, 'regaining visibility never starts recording');
  editor.record();
  instances[1].onstart(); instances[1].onaudiostart();
  const late = instances[1].onresult;
  world.session = undefined;
  world.renderer.xr.dispatchEvent({ type: 'sessionend' });
  assert.equal(instances[1].abortCalls, 1);
  assert.equal(editor.voice.active, false);
  assert.equal(system.composer.root.visible, false);
  late(speechResult('late transcription'));
  assert.equal(system.mail.draft.message, 'Keep this draft.');
  assert.equal(system.mail.sent.length, 0);
  editor.dispose();
});

test('open-palm sweeps require steady intent and reject slow, diagonal and interrupted motion', () => {
  const { PalmSwipeTracker } = loadModule('palm-swipe.js');
  const yaw = new core.Quaternion().setFromAxisAngle(new core.Vector3(0, 1, 0), Math.PI / 3);
  const point = (x, y = 0, z = 0) => new core.Vector3(x, y, z).applyQuaternion(yaw);
  const arm = (tracker) => {
    for (let i = 0; i <= 8; i++) assert.equal(tracker.add(point(0), yaw, i * .02), 0);
    assert.equal(tracker.ready, true);
  };
  for (const sign of [-1, 1]) {
    const tracker = new PalmSwipeTracker(); arm(tracker);
    let result = 0;
    for (let i = 1; i <= 7; i++) result ||= tracker.add(point(sign * .02 * i), yaw, .16 + i * .025);
    assert.equal(result, sign);
    assert.equal(tracker.add(point(sign * .3), yaw, .4), 0, 'one action per gesture');
  }
  for (const movement of [i => point(i * .002), i => point(i * .015, i * .015), i => point(0, 0, i * .02)]) {
    const tracker = new PalmSwipeTracker(); arm(tracker);
    for (let i = 1; i <= 40; i++) assert.equal(tracker.add(movement(i), yaw, .16 + i * .02), 0);
  }
  const tracker = new PalmSwipeTracker(); arm(tracker);
  assert.equal(tracker.add(point(.15), yaw, 1), 0, 'tracking gaps cannot become a swipe');
  assert.equal(tracker.ready, false);
});

test('tracked open palms spin the carousel; fists, pinches and system UI do not', () => {
  const { world, system } = setup();
  world.session = new EventTarget();
  world.session.visibilityState = 'visible';
  for (let i = 0; i < 8; i++) world.update(.02, 0);
  const slotCount = system.slots.length;
  const cards = system.slots.slice();
  const card = cards[2];
  const start = card.object3D.position.clone();
  const origin = start.clone().add(new core.Vector3(0, -.01, .08));
  let closed = false, pinched = false, missing = false;
  const joints = new Map();
  joints.set('wrist', new core.Vector3());
  joints.set('middle-finger-metacarpal', new core.Vector3(0, .02, 0));
  for (const [i, finger] of ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'].entries()) {
    const x = (i - 1) * .018;
    joints.set(`${finger}-phalanx-proximal`, new core.Vector3(x, .05, 0));
    joints.set(`${finger}-phalanx-intermediate`, new core.Vector3(x, .085, 0));
    joints.set(`${finger}-tip`, new core.Vector3(x, .13, 0));
  }
  joints.set('thumb-tip', new core.Vector3(-.09, .06, 0));
  const source = { hand: { get: name => joints.has(name) ? name : undefined }, handedness: 'right' };
  world.input.xr.getPrimaryInputSource = hand => hand === 'right' ? source : undefined;
  world.player.localToWorld = point => point;
  world.renderer.xr.getReferenceSpace = () => ({});
  world.renderer.xr.getFrame = () => ({ getJointPose(name) {
    if (missing) return null;
    const p = joints.get(pinched && name === 'thumb-tip' ? 'index-finger-tip' : name).clone();
    if (closed && name.endsWith('-tip')) p.y = .04;
    p.add(origin);
    return { emulatedPosition: false, transform: { position: p } };
  } });
  const sweep = sign => {
    for (let i = 0; i < 9; i++) world.update(.02, 0);
    for (let i = 0; i < 7; i++) {
      origin.add(new core.Vector3(sign * .022, 0, 0).applyQuaternion(system.anchorYawQ));
      world.update(.025, 0);
    }
  };
  const homeOf = (entity) => new core.Vector3(...entity.getVectorView(EmailCard, 'homePosition'));
  const slotOf = (entity) => entity.getValue(EmailCard, 'slotIndex');
  const homes = cards.map(homeOf);
  closed = true; sweep(1);
  assert.ok(homeOf(card).distanceTo(start) < 1e-6, 'a fist does nothing');
  origin.copy(start).y -= .01;
  closed = false; pinched = true; sweep(-1);
  assert.ok(homeOf(card).distanceTo(start) < 1e-6, 'a pinch does nothing');
  pinched = false; origin.copy(start).y -= .01;
  world.session.visibilityState = 'visible-blurred'; sweep(1);
  assert.ok(homeOf(card).distanceTo(start) < 1e-6, 'system UI pauses the gesture');
  world.session.visibilityState = 'visible'; origin.copy(start).y -= .01;
  // Right sweep: every queued card rotates one slot right, wrapping around.
  sweep(1);
  for (let s = 0; s < slotCount; s++) {
    const moved = cards[s];
    const slot = (s + 1) % slotCount;
    assert.equal(system.slots[slot], moved, `slot ${s} rotates to ${slot}`);
    assert.equal(slotOf(moved), slot);
    assert.ok(homeOf(moved).distanceTo(homes[slot]) < 1e-6, 'home follows the new slot');
  }
  assert.equal(system.remaining, 15);
  assert.equal(system.mail.inbox.length, 15);
  assert.equal(system.lastAction, null);
  // Cards glide to their new slots and settle back to Queued.
  for (let i = 0; i < 100; i++) world.update(.02, 0);
  for (let s = 0; s < slotCount; s++) {
    const moved = cards[s];
    assert.ok(moved.object3D.position.distanceTo(homeOf(moved)) < .001, 'card glides home');
    assert.equal(moved.getValue(EmailCard, 'state'), CardState.Queued);
  }
  assert.ok(homeOf(card).distanceTo(homes[3]) < 1e-6, 'a lingering palm does not repeat');
  missing = true; world.update(.02, 0); missing = false;
  origin.copy(homeOf(card)).y -= .01;
  // Left sweep: everything rotates back without deleting anything.
  sweep(-1);
  for (let s = 0; s < slotCount; s++) {
    assert.equal(system.slots[s], cards[s], `slot ${s} restored`);
    assert.equal(slotOf(cards[s]), s);
    assert.ok(homeOf(cards[s]).distanceTo(homes[s]) < 1e-6);
  }
  assert.equal(system.remaining, 15);
  assert.equal(system.mail.inbox.length, 15);
  assert.equal(system.lastAction, null);
});
