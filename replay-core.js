/*
 * Deterministic 12x12 two-player replay engine.
 *
 * This file has no browser, network, or third-party dependencies. It is loaded
 * as a normal <script> by index.html, embedded verbatim as source for an
 * in-memory Worker, and imported by the Node.js tests.
 */
function createReplayCore() {
  const GRID_SIZE = 12;
  const MAX_TICKS = 300;
  const CHECKPOINT_INTERVAL = 10;

  const DIRECTIONS = Object.freeze({
    stay: { dx: 0, dy: 0 },
    up: { dx: 0, dy: -1 },
    down: { dx: 0, dy: 1 },
    left: { dx: -1, dy: 0 },
    right: { dx: 1, dy: 0 }
  });

  const COMMAND_ALIASES = new Map([
    ['stay', 'stay'], ['s', 'stay'], ['.', 'stay'], ['-', 'stay'], ['_', 'stay'],
    ['停', 'stay'], ['停留', 'stay'], ['原地', 'stay'], ['等待', 'stay'],
    ['up', 'up'], ['u', 'up'], ['上', 'up'], ['向上', 'up'],
    ['down', 'down'], ['d', 'down'], ['下', 'down'], ['向下', 'down'],
    ['left', 'left'], ['l', 'left'], ['左', 'left'], ['向左', 'left'],
    ['right', 'right'], ['r', 'right'], ['右', 'right'], ['向右', 'right']
  ]);

  const DEFAULT_SCENARIO = deepFreeze({
    width: GRID_SIZE,
    height: GRID_SIZE,
    players: {
      a: { x: 1, y: 1 },
      b: { x: 10, y: 10 }
    },
    pickups: [
      { id: 'P1', x: 5, y: 1, points: 10 },
      { id: 'P2', x: 1, y: 5, points: 10 },
      { id: 'P3', x: 5, y: 5, points: 15 },
      { id: 'P4', x: 10, y: 6, points: 10 },
      { id: 'P5', x: 6, y: 10, points: 10 },
      { id: 'P6', x: 9, y: 9, points: 15 },
      { id: 'P7', x: 11, y: 11, points: 20 },
      { id: 'P8', x: 0, y: 10, points: 20 },
      { id: 'P9', x: 10, y: 0, points: 20 }
    ]
  });

  const STAY_PAIR = deepFreeze({ a: 'stay', b: 'stay' });

  function deepFreeze(value) {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
      return value;
    }
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function positionKey(x, y) {
    return `${x},${y}`;
  }

  function samePosition(a, b) {
    return a.x === b.x && a.y === b.y;
  }

  function finiteInteger(value, name) {
    if (!Number.isInteger(value)) {
      throw new Error(`${name} must be an integer`);
    }
    return value;
  }

  function normalizeScenario(input) {
    const raw = input == null ? cloneJson(DEFAULT_SCENARIO) : cloneJson(input);
    if (raw.width !== GRID_SIZE || raw.height !== GRID_SIZE) {
      throw new Error(`board must be exactly ${GRID_SIZE}x${GRID_SIZE}`);
    }

    const players = {};
    for (const who of ['a', 'b']) {
      const source = raw.players && raw.players[who];
      if (!source) throw new Error(`missing starting position for player ${who}`);
      const x = finiteInteger(source.x, `player ${who}.x`);
      const y = finiteInteger(source.y, `player ${who}.y`);
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) {
        throw new Error(`player ${who} starts outside the board`);
      }
      players[who] = { x, y };
    }
    if (samePosition(players.a, players.b)) {
      throw new Error('players cannot start on the same cell');
    }

    const usedCells = new Set([
      positionKey(players.a.x, players.a.y),
      positionKey(players.b.x, players.b.y)
    ]);
    const usedIds = new Set();
    const pickups = (Array.isArray(raw.pickups) ? raw.pickups : []).map((item, index) => {
      const source = item || {};
      const id = String(source.id == null ? `P${index + 1}` : source.id);
      if (usedIds.has(id)) throw new Error(`duplicate pickup id: ${id}`);
      usedIds.add(id);

      const x = finiteInteger(source.x, `pickup ${id}.x`);
      const y = finiteInteger(source.y, `pickup ${id}.y`);
      if (x < 0 || x >= GRID_SIZE || y < 0 || y >= GRID_SIZE) {
        throw new Error(`pickup ${id} is outside the board`);
      }
      const key = positionKey(x, y);
      if (usedCells.has(key)) {
        throw new Error(`pickup ${id} shares a starting/player cell at (${x}, ${y})`);
      }
      usedCells.add(key);

      const points = Number(source.points == null ? 10 : source.points);
      if (!Number.isFinite(points) || points <= 0) {
        throw new Error(`pickup ${id} has invalid points`);
      }
      return deepFreeze({ id, x, y, points });
    });

    return deepFreeze({ width: GRID_SIZE, height: GRID_SIZE, players, pickups });
  }

  function normalizeCommand(value) {
    if (typeof value !== 'string') {
      throw new Error(`command must be a string, got ${String(value)}`);
    }
    const normalized = COMMAND_ALIASES.get(value.trim().toLowerCase());
    if (!normalized) {
      throw new Error(`unknown command: ${value}`);
    }
    return normalized;
  }

  function normalizePair(input) {
    let a;
    let b;
    if (Array.isArray(input)) {
      [a, b] = input;
    } else if (input && typeof input === 'object') {
      a = input.a !== undefined ? input.a : input.A;
      b = input.b !== undefined ? input.b : input.B;
    } else {
      throw new Error(`command pair must be an object or array, got ${String(input)}`);
    }
    if (a === undefined || a === null) a = 'stay';
    if (b === undefined || b === null) b = 'stay';
    return deepFreeze({ a: normalizeCommand(a), b: normalizeCommand(b) });
  }

  function samePair(a, b) {
    return !!a && !!b && a.a === b.a && a.b === b.b;
  }

  function sparseFromJson(json) {
    const sparse = [];
    if (Array.isArray(json)) {
      json.forEach((item, tick) => {
        sparse[tick] = item == null ? STAY_PAIR : normalizePair(item);
      });
      return sparse;
    }
    if (!json || typeof json !== 'object') {
      throw new Error('JSON log must be an array or object');
    }
    if (json.ticks !== undefined) return sparseFromJson(json.ticks);
    if (Array.isArray(json.a) || Array.isArray(json.b)) {
      const aCommands = json.a || [];
      const bCommands = json.b || [];
      const length = Math.max(aCommands.length, bCommands.length);
      if (length > MAX_TICKS) throw new Error(`log cannot exceed ${MAX_TICKS} ticks`);
      for (let tick = 0; tick < length; tick += 1) {
        sparse[tick] = normalizePair([
          aCommands[tick] == null ? 'stay' : aCommands[tick],
          bCommands[tick] == null ? 'stay' : bCommands[tick]
        ]);
      }
      return sparse;
    }

    for (const key of Object.keys(json)) {
      if (!/^\d+$/.test(key)) throw new Error(`unexpected log field: ${key}`);
      const tick = Number(key);
      if (tick < 0 || tick >= MAX_TICKS) {
        throw new Error(`tick ${tick} is outside 0..${MAX_TICKS - 1}`);
      }
      sparse[tick] = normalizePair(json[key]);
    }
    return sparse;
  }

  function parseSparseLog(text, options = {}) {
    const implicitStart = Number.isInteger(options.implicitStart) ? options.implicitStart : 0;
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return [];
    if (raw.startsWith('{') || raw.startsWith('[')) {
      return sparseFromJson(JSON.parse(raw));
    }

    const sparse = [];
    let implicitTick = implicitStart;
    const lines = raw.split(/\r?\n/);
    lines.forEach((originalLine, lineIndex) => {
      const line = originalLine.replace(/#.*$/, '').replace(/\/\/.*$/, '').trim();
      if (!line) return;

      const parts = line.match(/[^\s,]+/g) || [];
      let tick;
      let commandOffset;
      if (/^\d+$/.test(parts[0])) {
        tick = Number(parts[0]);
        commandOffset = 1;
      } else {
        tick = implicitTick;
        commandOffset = 0;
      }
      if (tick < 0 || tick >= MAX_TICKS) {
        throw new Error(`line ${lineIndex + 1}: tick ${tick} is outside 0..${MAX_TICKS - 1}`);
      }
      if (parts.length - commandOffset !== 2) {
        throw new Error(`line ${lineIndex + 1}: expected "<tick> <commandA> <commandB>"`);
      }
      sparse[tick] = normalizePair([parts[commandOffset], parts[commandOffset + 1]]);
      implicitTick = tick + 1;
    });
    return sparse;
  }

  function normalizeLog(input) {
    if (input == null) return [];
    if (typeof input === 'string') return normalizeLog(parseSparseLog(input));

    let source;
    if (Array.isArray(input)) {
      source = input;
    } else if (typeof input === 'object') {
      if (input.ticks !== undefined) return normalizeLog(input.ticks);
      if (Array.isArray(input.a) || Array.isArray(input.b)) {
        const aCommands = input.a || [];
        const bCommands = input.b || [];
        const length = Math.max(aCommands.length, bCommands.length);
        const dense = [];
        for (let tick = 0; tick < length; tick += 1) {
          dense[tick] = normalizePair([
            aCommands[tick] == null ? 'stay' : aCommands[tick],
            bCommands[tick] == null ? 'stay' : bCommands[tick]
          ]);
        }
        if (dense.length > MAX_TICKS) throw new Error(`log cannot exceed ${MAX_TICKS} ticks`);
        return dense;
      }
      return normalizeLog(sparseFromJson(input));
    } else {
      throw new Error('unsupported log format');
    }

    if (source.length > MAX_TICKS) {
      throw new Error(`log cannot exceed ${MAX_TICKS} ticks`);
    }
    const dense = [];
    for (let tick = 0; tick < source.length; tick += 1) {
      dense[tick] = Object.prototype.hasOwnProperty.call(source, tick) && source[tick] != null
        ? normalizePair(source[tick])
        : STAY_PAIR;
    }
    return dense;
  }

  function parseLog(text) {
    return normalizeLog(parseSparseLog(text));
  }

  function createInitialState(scenario) {
    return deepFreeze({
      tick: 0,
      positions: {
        a: { ...scenario.players.a },
        b: { ...scenario.players.b }
      },
      scores: { a: 0, b: 0 },
      collected: {}
    });
  }

  function collectedIds(collected) {
    return Object.values(collected)
      .sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id))
      .map((entry) => entry.id);
  }

  function initialFrame(state) {
    return deepFreeze({
      tick: 0,
      positions: state.positions,
      scores: state.scores,
      collected: [],
      collectedById: state.collected,
      commands: null,
      intended: null,
      walls: null,
      collision: null,
      moved: null,
      pickups: null,
      events: []
    });
  }

  function transitionFrame(state, transition) {
    return deepFreeze({
      tick: state.tick,
      positions: state.positions,
      scores: state.scores,
      collected: collectedIds(state.collected),
      collectedById: state.collected,
      commands: transition.commands,
      intended: transition.intended,
      walls: transition.walls,
      collision: transition.collision,
      moved: transition.moved,
      pickups: transition.pickups,
      events: transition.events
    });
  }

  function pickupAt(scenario, position) {
    return scenario.pickups.find((pickup) => (
      pickup.x === position.x && pickup.y === position.y
    )) || null;
  }

  // All wall, meeting, swap, and pickup decisions are made from the pair of
  // simultaneous intents. Neither player's result is read before the other's
  // intent is known, so swapping A/B arrival order cannot change the result.
  function advanceState(state, commands, tick, scenario) {
    const pair = normalizePair(commands);
    const oldPositions = {
      a: state.positions.a,
      b: state.positions.b
    };
    const intended = {};
    const walls = {};
    const events = [];

    for (const who of ['a', 'b']) {
      const delta = DIRECTIONS[pair[who]];
      const rawX = oldPositions[who].x + delta.dx;
      const rawY = oldPositions[who].y + delta.dy;
      const hitWall = rawX < 0 || rawX >= GRID_SIZE || rawY < 0 || rawY >= GRID_SIZE;
      walls[who] = hitWall;
      intended[who] = hitWall ? { ...oldPositions[who] } : { x: rawX, y: rawY };
      if (hitWall) events.push(`WALL_${who.toUpperCase()}`);
    }

    const sameTarget = samePosition(intended.a, intended.b);
    const swap = !sameTarget
      && samePosition(intended.a, oldPositions.b)
      && samePosition(intended.b, oldPositions.a);
    const collision = sameTarget ? 'same-cell' : swap ? 'swap' : null;
    if (collision === 'same-cell') events.push('COLLISION_SAME_CELL');
    if (collision === 'swap') events.push('SWAP_POSITIONS');

    // A wall only blocks the player who attempted to leave the board. A
    // meeting/swap blocks both participants, while any unrelated player still
    // uses the movement decision calculated from the simultaneous pair.
    const blocked = {
      a: walls.a || !!collision,
      b: walls.b || !!collision
    };
    const nextPositions = {
      a: { ...(blocked.a ? oldPositions.a : intended.a) },
      b: { ...(blocked.b ? oldPositions.b : intended.b) }
    };
    const moved = {
      a: !blocked.a && !samePosition(oldPositions.a, nextPositions.a),
      b: !blocked.b && !samePosition(oldPositions.b, nextPositions.b)
    };

    let collected = state.collected;
    let scores = state.scores;
    const gained = { a: null, b: null };

    if (!collision) {
      for (const who of ['a', 'b']) {
        if (!moved[who]) continue;
        const pickup = pickupAt(scenario, nextPositions[who]);
        if (pickup && !collected[pickup.id]) {
          collected = {
            ...collected,
            [pickup.id]: deepFreeze({
              id: pickup.id,
              by: who,
              tick: tick + 1,
              points: pickup.points
            })
          };
          scores = { ...scores, [who]: scores[who] + pickup.points };
          gained[who] = deepFreeze({ id: pickup.id, points: pickup.points });
          events.push(`PICKUP_${who.toUpperCase()}_${pickup.id}`);
        }
      }
    }

    const nextState = deepFreeze({
      tick: tick + 1,
      positions: deepFreeze(nextPositions),
      scores: deepFreeze(scores),
      collected: deepFreeze(collected)
    });

    return deepFreeze({
      state: nextState,
      commands: pair,
      intended: deepFreeze(intended),
      walls: deepFreeze(walls),
      collision,
      moved: deepFreeze(moved),
      pickups: deepFreeze(gained),
      events: deepFreeze(events)
    });
  }

  function simulate(scenario, commands) {
    let state = createInitialState(scenario);
    const frames = [initialFrame(state)];
    const checkpoints = new Map([[0, state]]);
    for (let tick = 0; tick < commands.length; tick += 1) {
      const transition = advanceState(state, commands[tick], tick, scenario);
      state = transition.state;
      frames.push(transitionFrame(state, transition));
      if (state.tick % CHECKPOINT_INTERVAL === 0) {
        checkpoints.set(state.tick, state);
      }
    }
    return { state, frames, checkpoints };
  }

  function buildResult(scenario, commands, frames, checkpoints) {
    const checkpointTicks = [...checkpoints.keys()]
      .filter((tick) => tick % CHECKPOINT_INTERVAL === 0)
      .sort((a, b) => a - b);
    return deepFreeze({
      schemaVersion: 1,
      gridSize: GRID_SIZE,
      scenario,
      commands: commands.map((pair) => ({ ...pair })),
      frames: frames.slice(),
      checkpointTicks,
      checkpoints: checkpointTicks.map((tick) => checkpoints.get(tick))
    });
  }

  function runReplay(scenarioInput, commandsInput) {
    const scenario = normalizeScenario(scenarioInput);
    const commands = normalizeLog(commandsInput);
    const simulated = simulate(scenario, commands);
    return buildResult(scenario, commands, simulated.frames, simulated.checkpoints);
  }

  function createIncrementalReplay(scenarioInput) {
    const scenario = normalizeScenario(scenarioInput);
    let commands = [];
    let simulation = simulate(scenario, commands);

    let lastInfo = deepFreeze({
      changed: false,
      mode: 'init',
      minChangedTick: null,
      checkpointTick: 0
    });

    function fullRebuild() {
      simulation = simulate(scenario, commands);
    }

    function rebuildFrom(minChangedTick) {
      const checkpointTick = Math.floor(minChangedTick / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL;
      if (
        checkpointTick === 0
        || !simulation.checkpoints.has(checkpointTick)
        || simulation.frames.length < checkpointTick + 1
      ) {
        fullRebuild();
        lastInfo = deepFreeze({
          changed: true,
          mode: 'full',
          minChangedTick,
          checkpointTick: 0
        });
        return lastInfo;
      }

      let state = simulation.checkpoints.get(checkpointTick);
      const frames = simulation.frames.slice(0, checkpointTick + 1);
      const checkpoints = new Map(
        [...simulation.checkpoints].filter(([tick]) => tick <= checkpointTick)
      );

      for (let tick = checkpointTick; tick < commands.length; tick += 1) {
        const transition = advanceState(state, commands[tick], tick, scenario);
        state = transition.state;
        frames.push(transitionFrame(state, transition));
        if (state.tick % CHECKPOINT_INTERVAL === 0) {
          checkpoints.set(state.tick, state);
        }
      }

      simulation = { state, frames, checkpoints };
      lastInfo = deepFreeze({
        changed: true,
        mode: 'checkpoint',
        minChangedTick,
        checkpointTick
      });
      return lastInfo;
    }

    function replaceLog(input) {
      commands = normalizeLog(input);
      fullRebuild();
      lastInfo = deepFreeze({
        changed: true,
        mode: 'full',
        minChangedTick: 0,
        checkpointTick: 0
      });
      return lastInfo;
    }

    function asSparseArray(input) {
      if (typeof input === 'string') return parseSparseLog(input);
      if (Array.isArray(input)) {
        const sparse = [];
        for (let tick = 0; tick < input.length; tick += 1) {
          if (Object.prototype.hasOwnProperty.call(input, tick) && input[tick] != null) {
            sparse[tick] = normalizePair(input[tick]);
          }
        }
        return sparse;
      }
      if (input && typeof input === 'object') return sparseFromJson(input);
      throw new Error('unsupported sparse log format');
    }

    function mergeLog(input) {
      const sparse = asSparseArray(input);
      let minChangedTick = Infinity;
      let maxAssignedTick = -1;
      for (let tick = sparse.length - 1; tick >= 0; tick -= 1) {
        if (sparse[tick] != null) {
          maxAssignedTick = tick;
          break;
        }
      }
      const targetLength = maxAssignedTick + 1;

      if (targetLength > commands.length) {
        minChangedTick = commands.length;
      }
      while (commands.length < targetLength) {
        commands.push(STAY_PAIR);
      }

      for (const key of Object.keys(sparse)) {
        if (!/^\d+$/.test(key)) continue;
        const tick = Number(key);
        const nextPair = sparse[tick] || STAY_PAIR;
        const currentPair = commands[tick] || STAY_PAIR;
        if (!samePair(currentPair, nextPair)) {
          commands[tick] = nextPair;
          minChangedTick = Math.min(minChangedTick, tick);
        }
      }

      if (minChangedTick === Infinity) {
        lastInfo = deepFreeze({
          changed: false,
          mode: 'none',
          minChangedTick: null,
          checkpointTick: null
        });
      } else {
        rebuildFrom(minChangedTick);
      }
      return lastInfo;
    }

    function appendLog(input) {
      const firstTick = commands.length;
      let dense;
      if (typeof input === 'string') {
        const sparse = parseSparseLog(input, { implicitStart: firstTick });
        dense = [];
        for (let tick = 0; tick < sparse.length; tick += 1) {
          dense[tick] = Object.prototype.hasOwnProperty.call(sparse, tick) && sparse[tick] != null
            ? sparse[tick]
            : STAY_PAIR;
        }
      } else if (Array.isArray(input)) {
        if (firstTick + input.length > MAX_TICKS) {
          throw new Error(`log cannot exceed ${MAX_TICKS} ticks`);
        }
        dense = input.map((pair) => pair == null ? STAY_PAIR : normalizePair(pair));
      } else {
        throw new Error('batch input must be text or a dense array');
      }

      const sparse = [];
      dense.forEach((pair, offset) => {
        sparse[firstTick + offset] = pair;
      });
      return mergeLog(sparse);
    }

    return {
      scenario,
      replaceLog,
      replaceText: (text) => replaceLog(parseSparseLog(text)),
      mergeLog,
      mergeText: (text) => mergeLog(parseSparseLog(text)),
      appendLog,
      appendText: (text) => appendLog(text),
      getReplay() {
        return buildResult(scenario, commands, simulation.frames, simulation.checkpoints);
      },
      getLastInfo() {
        return lastInfo;
      }
    };
  }

  return {
    GRID_SIZE,
    MAX_TICKS,
    CHECKPOINT_INTERVAL,
    DEFAULT_SCENARIO,
    normalizeScenario,
    normalizeCommand,
    normalizePair,
    normalizeLog,
    parseSparseLog,
    parseLog,
    createInitialState,
    advanceState,
    runReplay,
    createIncrementalReplay
  };
}

const replayCoreApi = createReplayCore();

if (typeof module === 'object' && module.exports) {
  module.exports = replayCoreApi;
  module.exports.createReplayCore = createReplayCore;
  module.exports.default = replayCoreApi;
} else {
  self.ReplayCore = replayCoreApi;
  self.createReplayCore = createReplayCore;
}
