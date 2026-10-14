/* eslint-env mocha */

const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { Movements, goals } = require('..')
const AStar = require('../lib/astar')
const Move = require('../lib/move')

// A world of solid stone; the test carves corridors of air and water into it.
function fixture (version = '1.21.4') {
  const registry = require('minecraft-data')(version)
  const Block = require('prismarine-block')(version)
  const blocks = new Map()
  const bot = new EventEmitter()
  bot.registry = registry
  bot.game = { minY: -64 }
  bot.entity = { position: new Vec3(0.5, 64, 0.5), effects: {}, onGround: true }
  bot.entities = {}
  bot.inventory = { items: () => [] }
  bot.blockAt = p => {
    const position = p.floored()
    const b = Block.fromStateId(blocks.get(position.toString()) ?? registry.blocksByName.stone.defaultState, 0)
    b.position = position
    return b
  }
  const put = (name, x, y, z) => blocks.set(new Vec3(x, y, z).toString(), registry.blocksByName[name].defaultState)
  const movements = new Movements(bot)
  movements.canDig = false
  movements.maxSubmergedMoves = 6
  return { put, movements }
}

// A 1-wide corridor along +x at z = 0: feet at y = 64, head at 65, ceiling at 66.
// `cells` is one string per x: 'a' dry, 'w' water to the ceiling, 'p' water with air above the head.
function corridor (put, cells, z = 0) {
  cells.split('').forEach((kind, x) => {
    put(kind === 'a' ? 'air' : 'water', x, 64, z)
    put(kind === 'a' ? 'air' : 'water', x, 65, z)
    if (kind === 'p') put('air', x, 66, z)
  })
}

function plan (movements, toX, toZ = 0) {
  const start = new Move(0, 64, 0, 0, 0)
  return new AStar(start, movements, new goals.GoalBlock(toX, 64, toZ), 5000).compute()
}

describe('air budget', function () {
  it('counts a node as submerged only when the bot cannot get its face out of the water', function () {
    const { put, movements } = fixture()
    corridor(put, 'awp')
    put('water', 3, 64, 0); put('water', 3, 65, 0); put('water', 3, 66, 0)
    assert.strictEqual(movements.isSubmerged(new Vec3(0, 64, 0)), false) // dry
    assert.strictEqual(movements.isSubmerged(new Vec3(1, 64, 0)), true) // water under a ceiling
    assert.strictEqual(movements.isSubmerged(new Vec3(2, 64, 0)), false) // floats up into air
    assert.strictEqual(movements.isSubmerged(new Vec3(3, 64, 0)), true) // deeper water above
  })

  it('refuses a flooded tunnel longer than the budget', function () {
    const { put, movements } = fixture()
    corridor(put, 'aa' + 'w'.repeat(movements.maxSubmergedMoves + 1) + 'aa')
    const r = plan(movements, movements.maxSubmergedMoves + 4)
    assert.strictEqual(r.status, 'noPath')
  })

  it('takes a flooded stretch that fits in one breath', function () {
    const { put, movements } = fixture()
    corridor(put, 'aa' + 'w'.repeat(movements.maxSubmergedMoves) + 'aa')
    const r = plan(movements, movements.maxSubmergedMoves + 3)
    assert.strictEqual(r.status, 'success')
  })

  it('breathes between dives: two stretches each within budget, with air in between', function () {
    const { put, movements } = fixture()
    const dive = 'w'.repeat(movements.maxSubmergedMoves)
    corridor(put, 'a' + dive + 'p' + dive + 'a')
    const r = plan(movements, 2 * movements.maxSubmergedMoves + 2)
    assert.strictEqual(r.status, 'success')
  })

  it('swims any distance at the surface', function () {
    const { put, movements } = fixture()
    corridor(put, 'a' + 'p'.repeat(30) + 'a')
    const r = plan(movements, 31)
    assert.strictEqual(r.status, 'success')
  })

  it('takes a dry detour instead of a tunnel too long to hold its breath', function () {
    const { put, movements } = fixture()
    const n = movements.maxSubmergedMoves + 2
    corridor(put, 'a' + 'w'.repeat(n) + 'a')
    // the detour, longer than the tunnel: out to z = 6 at x = 0, along it, back at the goal
    corridor(put, 'a'.repeat(n + 2), 6)
    for (let z = 1; z < 6; z++) {
      put('air', 0, 64, z); put('air', 0, 65, z)
      put('air', n + 1, 64, z); put('air', n + 1, 65, z)
    }
    const r = plan(movements, n + 1)
    assert.strictEqual(r.status, 'success')
    assert.ok(r.path.every(p => p.z !== 0 || p.x === 0 || p.x === n + 1), 'the path goes around the tunnel')
  })

  it('does not let a long dive into a node shut out a shorter one that reaches it later', function () {
    // A* closes each place once. The cheap route dives at once and reaches the tunnel's last
    // stretch with its air used up; a longer dry route reaches the same stretch later with full
    // lungs. The planner must still take the dry route in.
    const { put, movements } = fixture()
    const b = movements.maxSubmergedMoves
    corridor(put, 'a' + 'w'.repeat(b + 1) + 'a') // z = 0: x = 1..b+1 flooded, goal dry at b + 2
    corridor(put, 'a'.repeat(b + 1), 6) // the dry route, along z = 6
    for (let z = 1; z < 6; z++) {
      put('air', 0, 64, z); put('air', 0, 65, z)
      put('air', b, 64, z); put('air', b, 65, z) // rejoins the tunnel at x = b
    }
    const r = plan(movements, b + 2)
    assert.strictEqual(r.status, 'success')
  })
})
