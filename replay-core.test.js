const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('./replay-core.js');

function assertReplayEqual(actual, expected, message) {
  assert.deepEqual(actual.commands, expected.commands, `${message}: commands`);
  assert.deepEqual(actual.frames, expected.frames, `${message}: frames`);
  assert.deepEqual(actual.checkpointTicks, expected.checkpointTicks, `${message}: checkpoint ticks`);
  assert.deepEqual(actual.checkpoints, expected.checkpoints, `${message}: checkpoint states`);
}

function commandPair(a, b) {
  return { a, b };
}

function makeSparseEdit(tick, pair) {
  const sparse = [];
  sparse[tick] = pair;
  return sparse;
}

function makeLog(length, selector = () => ['stay', 'stay']) {
  return Array.from({ length }, (_, tick) => commandPair(...selector(tick)));
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shuffled(items, random) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

test('board is fixed at 12×12 and logs are capped at 300 ticks', () => {
  assert.equal(core.GRID_SIZE, 12);
  assert.equal(core.MAX_TICKS, 300);
  assert.throws(
    () => core.normalizeScenario({ width: 10, height: 10, players: {}, pickups: [] }),
    /exactly 12x12/
  );
  assert.equal(core.normalizeLog(makeLog(300)).length, 300);
  assert.throws(() => core.normalizeLog(makeLog(301)), /cannot exceed 300/);
});

test('wall decisions are deterministic and simultaneous', () => {
  const scenario = core.normalizeScenario({
    width: 12,
    height: 12,
    players: { a: { x: 0, y: 0 }, b: { x: 11, y: 11 } },
    pickups: []
  });
  const state = core.createInitialState(scenario);
  const transition = core.advanceState(state, { a: 'up', b: 'right' }, 0, scenario);

  assert.deepEqual(transition.walls, { a: true, b: true });
  assert.deepEqual(transition.state.positions, {
    a: { x: 0, y: 0 },
    b: { x: 11, y: 11 }
  });
  assert.deepEqual(transition.events, ['WALL_A', 'WALL_B']);
  assert.deepEqual(transition.moved, { a: false, b: false });
});

test('same-cell meeting blocks both players and gives neither a pickup', () => {
  const scenario = core.normalizeScenario({
    width: 12,
    height: 12,
    players: { a: { x: 2, y: 1 }, b: { x: 4, y: 1 } },
    pickups: [{ id: 'G', x: 3, y: 1, points: 25 }]
  });
  const transition = core.advanceState(core.createInitialState(scenario), ['right', 'left'], 0, scenario);

  assert.equal(transition.collision, 'same-cell');
  assert.deepEqual(transition.state.positions, {
    a: { x: 2, y: 1 },
    b: { x: 4, y: 1 }
  });
  assert.deepEqual(transition.state.scores, { a: 0, b: 0 });
  assert.deepEqual(transition.events, ['COLLISION_SAME_CELL']);
  assert.equal(Object.keys(transition.state.collected).length, 0);
});

test('swap attempt is blocked independently of object/key arrival order', () => {
  const scenario = core.normalizeScenario({
    width: 12,
    height: 12,
    players: { a: { x: 5, y: 5 }, b: { x: 6, y: 5 } },
    pickups: []
  });
  const first = core.advanceState(
    core.createInitialState(scenario),
    { a: 'right', b: 'left' },
    0,
    scenario
  );
  const second = core.advanceState(
    core.createInitialState(scenario),
    JSON.parse('{"b":"left","a":"right"}'),
    0,
    scenario
  );

  assert.equal(first.collision, 'swap');
  assert.deepEqual(first.events, ['SWAP_POSITIONS']);
  assert.deepEqual(first.state.positions, { a: { x: 5, y: 5 }, b: { x: 6, y: 5 } });
  assert.deepEqual(first.state, second.state);
  assert.deepEqual(first.events, second.events);

  const separated = core.advanceState(
    core.createInitialState(scenario),
    { a: 'stay', b: 'stay' },
    0,
    scenario
  );
  assert.equal(separated.collision, null);
});

test('a wall does not block the other simultaneous move', () => {
  const scenario = core.normalizeScenario({
    width: 12,
    height: 12,
    players: { a: { x: 0, y: 0 }, b: { x: 2, y: 2 } },
    pickups: []
  });
  const transition = core.advanceState(
    core.createInitialState(scenario),
    { a: 'up', b: 'up' },
    0,
    scenario
  );
  assert.equal(transition.collision, null);
  assert.deepEqual(transition.state.positions, {
    a: { x: 0, y: 0 },
    b: { x: 2, y: 1 }
  });
  assert.deepEqual(transition.events, ['WALL_A']);
  assert.deepEqual(transition.moved, { a: false, b: true });
});

test('wall and same-cell collision are both recorded when they occur in the same tick', () => {
  const scenario = core.normalizeScenario({
    width: 12,
    height: 12,
    players: { a: { x: 0, y: 0 }, b: { x: 1, y: 0 } },
    pickups: []
  });
  const transition = core.advanceState(
    core.createInitialState(scenario),
    { a: 'left', b: 'left' },
    0,
    scenario
  );
  assert.equal(transition.collision, 'same-cell');
  assert.deepEqual(transition.walls, { a: true, b: false });
  assert.deepEqual(transition.state.positions, {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 0 }
  });
  assert.deepEqual(transition.events, ['WALL_A', 'COLLISION_SAME_CELL']);
  assert.deepEqual(transition.moved, { a: false, b: false });
});

test('one-time pickup scores only once and remains collected', () => {
  const scenario = core.normalizeScenario({
    width: 12,
    height: 12,
    players: { a: { x: 2, y: 1 }, b: { x: 4, y: 1 } },
    pickups: [{ id: 'G', x: 3, y: 1, points: 25 }]
  });
  const replay = core.runReplay(scenario, [
    ['right', 'stay'],
    ['stay', 'left'],
    ['right', 'stay']
  ]);

  assert.deepEqual(replay.frames[1].scores, { a: 25, b: 0 });
  assert.deepEqual(replay.frames[2].scores, { a: 25, b: 0 });
  assert.deepEqual(replay.frames[3].scores, { a: 25, b: 0 });
  assert.deepEqual(replay.frames[3].collected, ['G']);
  assert.equal(replay.frames[3].collectedById.G.by, 'a');
});

test('checkpoints are generated at tick zero and every ten ticks', () => {
  const replay = core.runReplay(null, makeLog(300));
  assert.equal(replay.frames.length, 301);
  assert.deepEqual(
    replay.checkpointTicks,
    Array.from({ length: 31 }, (_, index) => index * 10)
  );
  replay.checkpointTicks.forEach((tick, index) => {
    assert.equal(replay.checkpoints[index].tick, tick);
  });
});

test('incremental rebuild after an old edit equals from-scratch replay and uses the nearest unaffected checkpoint', () => {
  const log = makeLog(42, (tick) => [
    tick % 4 === 0 ? 'right' : 'stay',
    tick % 3 === 0 ? 'up' : 'stay'
  ]);
  const runner = core.createIncrementalReplay(core.DEFAULT_SCENARIO);
  runner.replaceLog(log);

  log[13] = { a: 'down', b: 'left' };
  const infoAt13 = runner.mergeLog(makeSparseEdit(13, log[13]));
  assert.equal(infoAt13.mode, 'checkpoint');
  assert.equal(infoAt13.minChangedTick, 13);
  assert.equal(infoAt13.checkpointTick, 10);
  assertReplayEqual(runner.getReplay(), core.runReplay(core.DEFAULT_SCENARIO, log), 'tick 13 edit');

  log[20] = { a: 'up', b: 'right' };
  const infoAt20 = runner.mergeLog(makeSparseEdit(20, log[20]));
  assert.equal(infoAt20.mode, 'checkpoint');
  assert.equal(infoAt20.checkpointTick, 20);
  assertReplayEqual(runner.getReplay(), core.runReplay(core.DEFAULT_SCENARIO, log), 'tick 20 edit');

  log[0] = { a: 'left', b: 'down' };
  const infoAt0 = runner.mergeLog(makeSparseEdit(0, log[0]));
  assert.equal(infoAt0.mode, 'full');
  assert.equal(infoAt0.checkpointTick, 0);
  assertReplayEqual(runner.getReplay(), core.runReplay(core.DEFAULT_SCENARIO, log), 'tick 0 edit');
});

test('same dense log delivered in sequential chunks matches one complete replay after every batch', () => {
  const length = 73;
  const moves = ['up', 'down', 'left', 'right', 'stay'];
  const log = makeLog(length, (tick) => [
    moves[(tick * 7 + 2) % moves.length],
    moves[(tick * 3 + 4) % moves.length]
  ]);
  const runner = core.createIncrementalReplay(core.DEFAULT_SCENARIO);

  for (let end = 0; end < length; end += 9) {
    const chunk = log.slice(end, Math.min(length, end + 9));
    runner.appendLog(chunk);
    const prefix = log.slice(0, Math.min(length, end + 9));
    assertReplayEqual(
      runner.getReplay(),
      core.runReplay(core.DEFAULT_SCENARIO, prefix),
      `chunks through tick ${end + chunk.length - 1}`
    );
  }

  assertReplayEqual(runner.getReplay(), core.runReplay(core.DEFAULT_SCENARIO, log), 'all chunks');
});

test('commands appended/changed at arbitrary ticks in different batches match full replay', () => {
  const random = mulberry32(20260930);
  const moves = ['up', 'down', 'left', 'right', 'stay'];
  const length = 88;
  const finalLog = makeLog(length, (tick) => [
    moves[Math.floor(random() * moves.length)],
    moves[Math.floor(random() * moves.length)]
  ]);

  const runner = core.createIncrementalReplay(core.DEFAULT_SCENARIO);
  const current = makeLog(length);
  const ticks = shuffled(finalLog.map((_, tick) => tick), random);

  ticks.forEach((tick) => {
    current[tick] = finalLog[tick];
    runner.mergeLog(makeSparseEdit(tick, finalLog[tick]));
    const expectedLength = runner.getReplay().commands.length;
    assertReplayEqual(
      runner.getReplay(),
      core.runReplay(core.DEFAULT_SCENARIO, current.slice(0, expectedLength)),
      `out-of-order tick ${tick}`
    );
  });

  assert.equal(runner.getReplay().commands.length, length);
});

test('text logs, Chinese/WASM aliases, sparse object logs, and comments parse equivalently', () => {
  const json = [
    ['r', 'u'],
    { a: '右', b: '上' },
    null,
    { a: 'stay', b: '左' }
  ];
  const dsl = [
    '0 r u # right/up',
    '1 右 上',
    '3 s 左 // wait/left'
  ].join('\n');
  const sparseObject = {
    0: ['r', 'u'],
    1: ['右', '上'],
    3: ['s', '左']
  };

  const fromJson = core.runReplay(core.DEFAULT_SCENARIO, json);
  const fromDsl = core.runReplay(core.DEFAULT_SCENARIO, dsl);
  const fromObject = core.runReplay(core.DEFAULT_SCENARIO, sparseObject);
  assertReplayEqual(fromDsl, fromJson, 'DSL vs JSON');
  assertReplayEqual(fromObject, fromJson, 'object vs JSON');
});

test('unchanged merge does not rebuild, while replacement always rebuilds all summaries', () => {
  const runner = core.createIncrementalReplay(core.DEFAULT_SCENARIO);
  runner.replaceText('0 right stay\n1 down left');
  const unchanged = runner.mergeText('0 right stay\n1 down left');
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.mode, 'none');

  const replacement = runner.replaceText('1 down left\n0 right stay');
  assert.equal(replacement.mode, 'full');
  assertReplayEqual(
    runner.getReplay(),
    core.runReplay(core.DEFAULT_SCENARIO, '0 right stay\n1 down left'),
    'replacement'
  );
});
