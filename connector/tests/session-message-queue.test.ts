import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionMessageQueue, QueueNativeNotEntered, QueueAuthorizationRequired, resolveQueueOperation, readQueueRecord, type QueueStore, type QueueRecord, type QueueReceipt } from '../src/session-message-queue.js'
const id = (n: number): string => Buffer.alloc(16, n).toString('base64url')
const scope = Buffer.alloc(32, 1).toString('base64url')
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
class Store implements QueueStore {
  value: QueueRecord | null = null
  before: (() => Promise<void>) | null = null
  lostAcknowledgement = false
  writes = 0
  async read(): Promise<unknown> { return copy(this.value) }
  async compareAndSwap(expected: number | null, next: QueueRecord, assertCurrent?: () => void): Promise<void> {
    await this.before?.()
    assertCurrent?.()
    if ((this.value?.revision ?? null) !== expected) throw Error('storage_conflict')
    this.value = copy(next); this.writes++
    if (this.lostAcknowledgement) { this.lostAcknowledgement = false; throw Error('storage_ack_lost') }
  }
}
async function setup() {
  const store = new Store()
  let time = 1000, owner = true
  const queue = await SessionMessageQueue.open(store, scope, id(1), () => { if (!owner) throw Error('owner_lost') }, () => time)
  return { queue, store, time: (v: number) => { time = v }, loseOwner: () => { owner = false } }
}
const accepted: QueueReceipt = { state: 'submitted', hostRef: 'native-turn-A' }

test('FIFO executes one item; an acceptance is not task completion and duplicate submit is not another execution', async () => {
  const { queue } = await setup(), calls: string[] = []
  await queue.enqueue(id(10), 'first'); await queue.enqueue(id(11), 'second')
  const invoke = (claim: { body: string }) => { calls.push(claim.body); return accepted }
  const result = await queue.dispatchNext(id(20), () => true, invoke)
  assert.equal(result.items[0].state, 'submitted')
  await queue.dispatchNext(id(21), () => true, invoke)
  await queue.enqueue(id(10), 'first')
  assert.deepEqual(calls, ['first'])
  await queue.reconcile(id(10), id(20), { state: 'completed', hostRef: 'native-turn-A' })
  await queue.dispatchNext(id(22), () => true, invoke)
  assert.deepEqual(calls, ['first', 'second'])
  assert.equal(queue.snapshot().items[0].body, '')
  await assert.rejects(queue.enqueue(id(10), 'changed'), /id_conflict/)
})

test('stop retains all pending text and does not resume from reads, new input, or idle notifications', async () => {
  const { queue } = await setup(), calls: string[] = []
  await queue.enqueue(id(10), '中文😀'.repeat(1200))
  await queue.enqueue(id(11), 'second')
  await queue.pause()
  await queue.enqueue(id(12), 'third')
  const invoke = (claim: { body: string }) => { calls.push(claim.body); return accepted }
  for (let i = 0; i < 3; i++) { queue.snapshot(); await queue.dispatchNext(id(20 + i), () => true, invoke) }
  assert.equal(queue.snapshot().items.length, 3)
  assert.equal(queue.snapshot().paused, 'user')
  assert.deepEqual(calls, [])
  await queue.resume(queue.snapshot().revision)
  assert.equal(queue.userInterrupted(), false)
  await queue.dispatchNext(id(23), () => true, invoke)
  assert.deepEqual(calls, ['中文😀'.repeat(1200)])
})

test('pause fences a durable claim in flight before it can invoke the native host', async () => {
  const { queue, store } = await setup(), entered = deferred(), release = deferred()
  await queue.enqueue(id(10), 'must not run')
  store.before = async () => { store.before = null; entered.resolve(); await release.promise }
  let calls = 0
  const dispatch = queue.dispatchNext(id(20), () => true, () => { calls++; return accepted })
  await entered.promise
  const stopped = queue.pause()
  release.resolve()
  await Promise.all([dispatch, stopped])
  assert.equal(calls, 0)
  assert.equal(queue.snapshot().items[0].state, 'waiting')
  assert.equal(queue.snapshot().paused, 'user')
  await queue.resume(queue.snapshot().revision)
  await queue.dispatchNext(id(21), () => true, () => { calls++; return accepted })
  assert.equal(calls, 1)
})

test('stop during an admitted call retains the second message; late acknowledgement cannot unpause', async () => {
  const { queue } = await setup(), entered = deferred(), release = deferred()
  await queue.enqueue(id(10), 'running'); await queue.enqueue(id(11), 'retained')
  let calls = 0
  const dispatch = queue.dispatchNext(id(20), () => true, async () => {
    calls++; entered.resolve(); await release.promise; return accepted
  })
  await entered.promise
  await queue.pause()
  release.resolve(); await dispatch
  await queue.reconcile(id(10), id(20), { state: 'completed', hostRef: 'native-turn-A' })
  await queue.dispatchNext(id(21), () => true, () => { calls++; return accepted })
  assert.equal(calls, 1)
  assert.equal(queue.snapshot().items[1].body, 'retained')
  assert.equal(queue.snapshot().paused, 'user')
})

test('concurrent LAN/relay claims and edits cannot dispatch the same queued item twice', async () => {
  const { queue } = await setup(), release = deferred(), entered = deferred()
  await queue.enqueue(id(10), 'once')
  let calls = 0
  const dispatch = queue.dispatchNext(id(20), () => true, async () => { calls++; entered.resolve(); await release.promise; return accepted })
  await entered.promise
  await Promise.all([
    queue.dispatchNext(id(21), () => true, () => { calls++; return accepted }),
    assert.rejects(queue.edit(id(10), 'new', queue.snapshot().revision), /not_waiting/),
    assert.rejects(queue.remove(id(10), queue.snapshot().revision), /not_waiting/)
  ])
  release.resolve(); await dispatch
  assert.equal(calls, 1)
})

test('unknown delivery is retained, blocks continuation, and only correlated host evidence can settle it', async () => {
  const { queue } = await setup()
  await queue.enqueue(id(10), 'uncertain'); await queue.enqueue(id(11), 'later')
  let calls = 0
  await queue.dispatchNext(id(20), () => true, () => { calls++; throw Error('network lost after acceptance') })
  assert.equal(queue.snapshot().paused, 'uncertain')
  assert.equal(queue.snapshot().items[0].state, 'unknown')
  assert.equal(queue.snapshot().items[0].body, 'uncertain')
  await assert.rejects(queue.resume(queue.snapshot().revision), /unconfirmed/)
  await assert.rejects(queue.reconcile(id(10), id(21), { state: 'completed', hostRef: 'native-turn-A' }), /scope/)
  await queue.dispatchNext(id(22), () => true, () => { calls++; return accepted })
  assert.equal(calls, 1)
  await queue.reconcile(id(10), id(20), { state: 'completed', hostRef: 'native-turn-A' })
  assert.equal(queue.snapshot().paused, 'uncertain')
  await queue.resume(queue.snapshot().revision)
  await queue.dispatchNext(id(23), () => true, () => { calls++; return accepted })
  assert.equal(calls, 2)
})

test('host completion racing with acknowledgement remains completed; conflicting late evidence is rejected', async () => {
  const { queue } = await setup()
  await queue.enqueue(id(10), 'quick')
  await queue.dispatchNext(id(20), () => true, async () => {
    await queue.reconcile(id(10), id(20), { state: 'completed', hostRef: 'native-turn-A' })
    return { state: 'unknown', hostRef: null }
  })
  assert.equal(queue.snapshot().items[0].state, 'completed')
  await assert.rejects(queue.reconcile(id(10), id(20), { state: 'rejected', hostRef: null }), /conflict/)
})

test('process restart preserves user pause and converts in-flight work to unknown without replay', async () => {
  const { queue, store } = await setup()
  await queue.enqueue(id(10), 'in flight'); await queue.enqueue(id(11), 'not sent')
  await queue.dispatchNext(id(20), () => true, () => accepted)
  await queue.pause(); queue.close()
  const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
  assert.equal(restored.snapshot().paused, 'user')
  assert.deepEqual(restored.snapshot().items.map(v => v.state), ['unknown', 'waiting'])
  let calls = 0
  await restored.dispatchNext(id(21), () => true, () => { calls++; return accepted })
  assert.equal(calls, 0)
  await assert.rejects(restored.resume(restored.snapshot().revision), /unconfirmed/)
})

test('even a waiting-only queue restarts paused; scope change or damaged records never become empty queues', async () => {
  const { queue, store } = await setup()
  await queue.enqueue(id(10), 'safe pending')
  queue.close()
  const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
  assert.equal(restored.snapshot().paused, 'recovery')
  await assert.rejects(SessionMessageQueue.open(store, Buffer.alloc(32, 2).toString('base64url'), id(3), () => {}, () => 3000), /identity/)
  store.value!.items[0].body += 'tampered'
  await assert.rejects(SessionMessageQueue.open(store, scope, id(3), () => {}, () => 3000), /invalid/)
})

for (const ended of ['empty', 'completed', 'rejected', 'deleted', 'dismissed'] as const) {
  test(`R125 normal ${ended} queue restart accepts one new message without resume or replay`, async () => {
    const { queue, store } = await setup()
    if (ended !== 'empty') {
      await queue.enqueue(id(10), 'old message')
      if (ended === 'deleted') await queue.remove(id(10), queue.snapshot().revision)
      else {
        await queue.dispatchNext(id(20), () => true, () => {
          if (ended === 'dismissed') throw Error('unknown old delivery')
          return ended === 'rejected' ? { state: 'rejected', hostRef: null } : accepted
        })
        if (ended === 'completed') await queue.reconcile(id(10), id(20), { state: 'completed', hostRef: 'native-turn-A' })
        if (ended === 'dismissed') {
          await queue.dismiss(id(10), queue.snapshot().revision)
          await queue.resume(queue.snapshot().revision)
        }
      }
    }
    assert.equal(queue.snapshot().paused, 'none')
    queue.close()
    const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
    const calls: string[] = []
    // Reading a restarted queue must never execute any old terminal item.
    await restored.dispatchNext(id(21), () => true, claim => { calls.push(claim.body); return accepted })
    assert.equal(calls.length, 0)
    await restored.enqueue(id(11), 'new message')
    await restored.dispatchNext(id(22), () => true, claim => { calls.push(claim.body); return accepted })
    assert.deepEqual(calls, ['new message'])
    assert.equal(restored.snapshot().paused, 'none')
    await restored.enqueue(id(11), 'new message')
    if (ended !== 'empty') await restored.enqueue(id(10), 'old message')
    await restored.dispatchNext(id(23), () => true, claim => { calls.push(claim.body); return accepted })
    assert.deepEqual(calls, ['new message'], 'new and historical idempotency survive restart')
    await restored.reconcile(id(11), id(22), { state: 'completed', hostRef: 'native-turn-A' })
    restored.close()
    const twice = await SessionMessageQueue.open(store, scope, id(3), () => {}, () => 3000)
    assert.equal(twice.snapshot().paused, 'none')
    assert.equal(twice.snapshot().items.every(item => item.body === ''), true)
  })
}

for (const paused of ['user', 'recovery', 'uncertain'] as const) {
  for (const hasTerminal of [false, true]) {
    test(`R125 existing ${paused} pause with ${hasTerminal ? 'terminal receipt' : 'empty queue'} remains explicit across restart`, async () => {
      const { queue, store } = await setup()
      if (hasTerminal) {
        await queue.enqueue(id(10), 'removed')
        await queue.remove(id(10), queue.snapshot().revision)
      }
      queue.close()
      // Valid persisted legacy pause: its original reason cannot be inferred from emptiness.
      store.value!.paused = paused
      const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
      await restored.enqueue(id(11), 'must remain waiting')
      let calls = 0
      await restored.dispatchNext(id(21), () => true, () => { calls++; return accepted })
      assert.equal(calls, 0)
      assert.equal(restored.snapshot().paused, paused === 'user' ? 'user' : 'recovery')
      assert.equal(restored.snapshot().items.at(-1)!.state, 'waiting')
      await restored.resume(restored.snapshot().revision)
      await restored.dispatchNext(id(22), () => true, () => { calls++; return accepted })
      assert.equal(calls, 1)
    })
  }
}

for (const pending of ['waiting', 'dispatching', 'submitted', 'unknown'] as const) {
  test(`R125 restart with ${pending} work never sends old or new messages automatically`, async () => {
    const { queue, store } = await setup()
    await queue.enqueue(id(10), 'pending original')
    if (pending === 'dispatching') {
      store.lostAcknowledgement = true
      await assert.rejects(queue.dispatchNext(id(20), () => true, () => accepted), /ack_lost/)
    } else if (pending !== 'waiting') {
      await queue.dispatchNext(id(20), () => true, () => {
        if (pending === 'unknown') throw Error('delivery unconfirmed')
        return accepted
      })
    }
    queue.close()
    assert.equal(store.value!.items[0].state, pending)
    const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
    await restored.enqueue(id(11), 'new retained')
    let calls = 0
    await restored.dispatchNext(id(21), () => true, () => { calls++; return accepted })
    assert.equal(calls, 0)
    assert.equal(restored.snapshot().paused, 'recovery')
    assert.equal(restored.snapshot().items[0].body, 'pending original')
    assert.equal(restored.snapshot().items[0].state, pending === 'waiting' ? 'waiting' : 'unknown')
  })
}

test('R125 terminal receipts do not hide a remaining waiting message during restart', async () => {
  const { queue, store } = await setup()
  await queue.enqueue(id(10), 'removed'); await queue.remove(id(10), queue.snapshot().revision)
  await queue.enqueue(id(11), 'still pending'); queue.close()
  const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
  let calls = 0
  await restored.dispatchNext(id(20), () => true, () => { calls++; return accepted })
  assert.equal(calls, 0)
  assert.equal(restored.snapshot().paused, 'recovery')
  assert.equal(restored.snapshot().items[1].body, 'still pending')
})

test('lost durable claim acknowledgement performs zero native calls and recovery never guesses retry', async () => {
  const { queue, store } = await setup()
  await queue.enqueue(id(10), 'may be recorded')
  store.lostAcknowledgement = true
  let calls = 0
  await assert.rejects(queue.dispatchNext(id(20), () => true, () => { calls++; return accepted }), /ack_lost/)
  assert.equal(calls, 0)
  await assert.rejects(queue.dispatchNext(id(21), () => true, () => { calls++; return accepted }), /unavailable/)
  const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
  assert.equal(restored.snapshot().items[0].state, 'unknown')
})

test('lost post-send storage acknowledgement keeps a durable receipt and cannot cause automatic resubmission', async () => {
  const { queue, store } = await setup()
  await queue.enqueue(id(10), 'one side effect')
  let calls = 0
  await assert.rejects(queue.dispatchNext(id(20), () => true, () => {
    calls++; store.lostAcknowledgement = true; return accepted
  }), /ack_lost/)
  assert.equal(calls, 1)
  assert.equal(store.value!.items[0].state, 'submitted')
  const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
  await restored.dispatchNext(id(21), () => true, () => { calls++; return accepted })
  assert.equal(calls, 1)
})

test('edit, delete and reorder apply only to observed waiting revisions; retained deletion defeats late retry', async () => {
  const { queue } = await setup()
  await queue.enqueue(id(10), 'a'); await queue.enqueue(id(11), 'b'); await queue.pause()
  const revision = queue.snapshot().revision
  await queue.edit(id(10), 'edited', revision)
  await assert.rejects(queue.remove(id(11), revision), /revision_changed/)
  await queue.reorder([id(11), id(10)], queue.snapshot().revision)
  assert.deepEqual(queue.snapshot().items.map(v => v.id), [id(11), id(10)])
  await assert.rejects(queue.reorder([id(10), id(10)], queue.snapshot().revision), /order/)
  await queue.remove(id(11), queue.snapshot().revision)
  await queue.enqueue(id(11), 'b')
  await queue.resume(queue.snapshot().revision)
  const calls: string[] = []
  await queue.dispatchNext(id(20), () => true, claim => { calls.push(claim.body); return accepted })
  assert.deepEqual(calls, ['edited'])
})

test('capacity and payload bounds cannot consume pause capacity; malicious/invalid snapshots are rejected', async () => {
  const { queue } = await setup()
  for (let i = 0; i < 16; i++) await queue.enqueue(id(10 + i), 'pending')
  await assert.rejects(queue.enqueue(id(99), 'overflow'), /capacity/)
  await queue.pause()
  assert.equal(queue.snapshot().paused, 'user')
  await assert.rejects(queue.edit(id(10), 'x'.repeat(32769), queue.snapshot().revision), /input/)
  await assert.rejects(queue.edit(id(10), '\ud800', queue.snapshot().revision), /input/)
  const snapshot = queue.snapshot()
  snapshot.items[0].body = 'external mutation'
  assert.equal(queue.snapshot().items[0].body, 'pending')
  assert.throws(() => readQueueRecord({ ...queue.snapshot(), extra: true }), /invalid/)
})

test('clock rollback, authority loss and runtime closing block dispatch', async () => {
  const f = await setup()
  await f.queue.enqueue(id(10), 'a')
  f.time(999)
  await assert.rejects(f.queue.dispatchNext(id(20), () => true, () => accepted), /clock/)
  f.time(2000)
  await assert.rejects(f.queue.dispatchNext(id(21), () => true, () => accepted), /unavailable/)
  const g = await setup()
  await g.queue.enqueue(id(10), 'b')
  g.loseOwner()
  await assert.rejects(g.queue.dispatchNext(id(20), () => true, () => accepted), /owner_lost/)
  const h = await setup()
  await h.queue.enqueue(id(10), 'c'); h.queue.close()
  await assert.rejects(h.queue.dispatchNext(id(20), () => true, () => accepted), /unavailable/)
})

test('a competing store writer fails CAS before side effects instead of overwriting its queue', async () => {
  const { queue, store } = await setup()
  await queue.enqueue(id(10), 'first')
  const second = await SessionMessageQueue.open(store, scope, id(1), () => {}, () => 1000)
  await second.enqueue(id(11), 'concurrent')
  let calls = 0
  await assert.rejects(queue.dispatchNext(id(20), () => true, () => { calls++; return accepted }), /storage_conflict/)
  assert.equal(calls, 0)
  assert.equal(store.value!.items.length, 2)
})

test('read-only AUTH refresh failure exposes recovery and retains original input until explicit resume', async () => {
  const { queue } = await setup()
  await queue.enqueue(id(10), 'retain for reconnect')
  let calls = 0
  const state = await queue.dispatchNext(id(20), () => true, () => { calls++; return accepted },
    async () => { throw new QueueAuthorizationRequired() })
  assert.equal(calls, 0)
  assert.equal(state.items[0].state, 'waiting')
  assert.equal(state.items[0].dispatchId, null)
  assert.equal(state.items[0].body, 'retain for reconnect')
  assert.equal(state.paused, 'recovery')
  assert.equal(queue.userInterrupted(), false)
  queue.snapshot(); await queue.settledSnapshot()
  await queue.enqueue(id(11), 'later input does not resume')
  await queue.dispatchNext(id(21), () => true, () => { calls++; return accepted })
  assert.equal(calls, 0)
  await queue.resume(queue.snapshot().revision)
  await queue.dispatchNext(id(22), () => true, () => { calls++; return accepted })
  await queue.dispatchNext(id(23), () => true, () => { calls++; return accepted })
  assert.equal(calls, 1)
  assert.equal(queue.snapshot().items[0].id, id(10))
})

test('authorization lost at final native guard exposes recovery; ordinary busy refusal remains retryable', async () => {
  for (const auth of [true, false]) {
    const { queue } = await setup()
    await queue.enqueue(id(10), 'retain at last guard')
    const state = await queue.dispatchNext(id(20), () => true, () => {
      throw auth ? new QueueAuthorizationRequired() : new QueueNativeNotEntered()
    })
    assert.equal(state.items[0].state, 'waiting')
    assert.equal(state.items[0].body, 'retain at last guard')
    assert.equal(state.paused, auth ? 'recovery' : 'none')
    let calls = 0
    await queue.dispatchNext(id(21), () => true, () => { calls++; return accepted })
    assert.equal(calls, auth ? 0 : 1)
  }
})

test('late authorization loss cannot overwrite a concurrent explicit user stop', async () => {
  const { queue } = await setup(), entered = deferred(), release = deferred()
  await queue.enqueue(id(10), 'stopped original')
  let calls = 0
  const dispatch = queue.dispatchNext(id(20), () => true, () => { calls++; return accepted }, async () => {
    entered.resolve(); await release.promise; throw new QueueAuthorizationRequired()
  })
  await entered.promise; await queue.pause(); release.resolve(); await dispatch
  assert.equal(queue.snapshot().paused, 'user')
  assert.equal(queue.userInterrupted(), true)
  assert.equal(queue.snapshot().items[0].body, 'stopped original')
  assert.equal(calls, 0)
})

test('stop or identity change during AUTH refresh fences the final native entry', async () => {
  for (const stopping of [true, false]) {
    const { queue } = await setup(), entered = deferred(), release = deferred()
    await queue.enqueue(id(10), 'original')
    let valid = true, calls = 0
    const sending = queue.dispatchNext(id(20), () => valid, () => { calls++; return accepted },
      async () => { entered.resolve(); await release.promise })
    await entered.promise
    if (stopping) await queue.pause(); else valid = false
    release.resolve()
    const state = await sending
    assert.equal(calls, 0)
    assert.equal(state.items[0].state, 'waiting')
    assert.equal(state.paused, stopping ? 'user' : 'none')
  }
})


test('mutation and operation receipt commit together even when the storage acknowledgement is lost', async () => {
  const { queue, store } = await setup()
  const op = { id: id(50), ticketDigest: scope }
  await queue.enqueue(id(10), 'before')
  store.lostAcknowledgement = true
  await assert.rejects(queue.edit(id(10), 'after', queue.snapshot().revision, op), /ack_lost/)
  const restored = await SessionMessageQueue.open(store, scope, id(2), () => {}, () => 2000)
  assert.equal(restored.snapshot().items[0].body, 'after')
  assert.equal(restored.snapshot().operations[0].ticketDigest, scope)
  const revision = restored.snapshot().revision
  await restored.edit(id(10), 'after', 2, op)
  assert.equal(restored.snapshot().revision, revision)
  await assert.rejects(restored.edit(id(10), 'after', 2, { ...op, ticketDigest: Buffer.alloc(32, 2).toString('base64url') }), /operation_conflict/)
})

test('old stop and resume replays cannot reverse a later explicit queue decision', async () => {
  const { queue } = await setup(), stop = { id: id(51), ticketDigest: scope }, resume = { id: id(52), ticketDigest: scope }
  await queue.pause(stop)
  await queue.resume(queue.snapshot().revision, resume)
  const afterResume = queue.snapshot().revision
  await queue.pause(stop)
  assert.equal(queue.snapshot().revision, afterResume)
  assert.equal(queue.userInterrupted(), false)
  await queue.pause({ id: id(53), ticketDigest: scope })
  await queue.resume(1, resume)
  assert.equal(queue.userInterrupted(), true)
  assert.equal(queue.snapshot().paused, 'user')
})

test('expired or revoked authorization at the final durable boundary commits neither body nor receipt', async () => {
  const { queue, store } = await setup(), entered = deferred(), release = deferred()
  let authorized = true
  const op = { id: id(50), ticketDigest: scope, assertCurrent: () => { if (!authorized) throw Error('authorization_expired') } }
  store.before = async () => { store.before = null; entered.resolve(); await release.promise }
  const write = queue.enqueue(id(10), 'do not commit', op)
  await entered.promise; authorized = false; release.resolve()
  await assert.rejects(write, /authorization_expired/)
  assert.equal(store.value!.items.length, 0)
  assert.equal(store.value!.operations.length, 0)
})

test('receipt parser rejects duplicate, future and impossible revision proofs', async () => {
  const { queue } = await setup()
  await queue.pause({ id: id(50), ticketDigest: scope })
  const first = queue.snapshot()
  assert.throws(() => readQueueRecord({ ...first, operations: [...first.operations, ...first.operations] }), /invalid/)
  for (const operation of [{ ...first.operations[0], appliedAt: first.highWater + 1 }, { ...first.operations[0], revision: first.revision + 1 }]) {
    assert.throws(() => readQueueRecord({ ...first, operations: [operation] }), /invalid/)
  }
})


test('positive exact native withdrawal retains input paused; a delayed admission reply cannot restore submitted', async () => {
  const { queue } = await setup(), entered = deferred(), release = deferred()
  await queue.enqueue(id(10), 'own pending')
  const sending = queue.dispatchNext(id(20), () => true, async () => { entered.resolve(); await release.promise; return accepted })
  await entered.promise
  await queue.pause()
  await queue.withdrawBeforeAdmission(id(10), id(20), () => true)
  release.resolve(); await sending
  assert.equal(queue.snapshot().items[0].state, 'waiting')
  assert.equal(queue.snapshot().items[0].body, 'own pending')
  assert.equal(queue.snapshot().paused, 'user')
})

test('failed or foreign withdrawal proof cannot reset delivered or unknown input', async () => {
  const { queue } = await setup()
  await queue.enqueue(id(10), 'retain')
  await queue.dispatchNext(id(20), () => true, () => accepted)
  await assert.rejects(queue.withdrawBeforeAdmission(id(10), id(21), () => true), /unproven/)
  await assert.rejects(queue.withdrawBeforeAdmission(id(10), id(20), () => false), /unproven/)
  assert.equal(queue.snapshot().items[0].state, 'submitted')
  const other = await setup(); await other.queue.enqueue(id(10), 'uncertain')
  await other.queue.dispatchNext(id(20), () => true, () => { throw Error('lost') })
  await assert.rejects(other.queue.withdrawBeforeAdmission(id(10), id(20), () => true), /unproven/)
  assert.equal(other.queue.snapshot().items[0].state, 'unknown')
})

test('a native adapter proving no entry preserves the message; ordinary invocation failure is still unknown', async () => {
  const { queue } = await setup()
  await queue.enqueue(id(10), 'never entered')
  await queue.dispatchNext(id(20), () => true, () => { throw new QueueNativeNotEntered() })
  assert.equal(queue.snapshot().items[0].state, 'waiting')
  assert.equal(queue.snapshot().items[0].dispatchId, null)
  await queue.dispatchNext(id(21), () => true, () => { throw Error('may have entered') })
  assert.equal(queue.snapshot().items[0].state, 'unknown')
})


test('resolution reads await committed serial writes and refuse a lost-storage acknowledgement', async () => {
  const f = await setup(), entered = deferred(), release = deferred()
  const operation = { id: id(50), ticketDigest: scope }
  f.store.before = async () => { f.store.before = null; entered.resolve(); await release.promise }
  const write = f.queue.enqueue(id(10), 'pending commit', operation)
  await entered.promise
  let readDone = false
  const read = f.queue.settledSnapshot().then(v => { readDone = true; return v })
  await new Promise(r => setTimeout(r, 10)); assert.equal(readDone, false)
  release.resolve(); await write
  const state = await read
  assert.equal(resolveQueueOperation(state, operation, 1000, 31000, 31000, true).state, 'applied')
  f.store.lostAcknowledgement = true
  await assert.rejects(f.queue.pause({ id: id(51), ticketDigest: scope }))
  await assert.rejects(f.queue.settledSnapshot(), /unavailable/)
})
test('negative proof requires same instance, expiry and retention; absence alone is never enough', async () => {
  const f = await setup(), state = await f.queue.settledSnapshot(), operation = { id: id(50), ticketDigest: scope }
  assert.equal(resolveQueueOperation(state, operation, 1000, 31000, 30999, true).state, 'unconfirmed')
  assert.equal(resolveQueueOperation(state, operation, 1000, 31000, 31000, true).state, 'not-recorded')
  assert.equal(resolveQueueOperation(state, operation, 1000, 31000, 31000, false).state, 'unconfirmed')
  assert.equal(resolveQueueOperation(state, operation, 1000, 31000, 86401000, true).state, 'unconfirmed')
})


test('explicit unknown dismissal preserves a tombstone and pause; only later waiting input resumes', async () => {
 const f=await setup(),q=f.queue,calls:string[]=[]
 await q.enqueue(id(10),'original');await q.enqueue(id(11),'later')
 await q.dispatchNext(id(20),()=>true,claim=>{calls.push(claim.body);return {state:'unknown',hostRef:null}})
 await q.pause();const revision=q.snapshot().revision;let retired=0
 const op={id:id(30),ticketDigest:Buffer.alloc(32,30).toString('base64url')}
 await assert.rejects(q.dismiss(id(10),revision-1,op,()=>{retired++}),/revision_changed/)
 await q.dismiss(id(10),revision,op,()=>{retired++});await q.dismiss(id(10),revision,op,()=>{retired++})
 assert.equal(retired,1);assert.equal(q.snapshot().items[0].state,'dismissed');assert.equal(q.snapshot().items[0].body,'')
 assert.equal(q.snapshot().items[0].dispatchId,id(20));assert.equal(q.snapshot().paused,'user')
 await q.reconcile(id(10),id(20),{state:'completed',hostRef:'late-native'});assert.equal(q.snapshot().items[0].state,'dismissed')
 await q.dispatchNext(id(21),()=>true,claim=>{calls.push(claim.body);return accepted});assert.deepEqual(calls,['original'])
 q.close();const reopened=await SessionMessageQueue.open(f.store,scope,id(2),()=>{},()=>1000)
 assert.equal(reopened.snapshot().items[0].state,'dismissed');assert.equal(reopened.snapshot().paused,'user')
 await reopened.resume(reopened.snapshot().revision);await reopened.dispatchNext(id(22),()=>true,claim=>{calls.push(claim.body);return accepted})
 assert.deepEqual(calls,['original','later']);reopened.close()
})

test('dismiss cannot erase waiting or confirmed native input and remains owner/commit scoped', async () => {
 const f=await setup(),q=f.queue;await q.enqueue(id(10),'original')
 await assert.rejects(q.dismiss(id(10),q.snapshot().revision),/not_unknown/)
 await q.dispatchNext(id(20),()=>true,()=>accepted)
 await assert.rejects(q.dismiss(id(10),q.snapshot().revision),/not_unknown/)
 await q.reconcile(id(10),id(20),{state:'unknown',hostRef:null})
 assert.equal(q.snapshot().items[0].state,'submitted');f.loseOwner()
 await assert.rejects(q.dismiss(id(10),1));q.close()
})
