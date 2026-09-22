import assert from "node:assert/strict";
import test from "node:test";
import { BurstScheduler, createBurstTimer, interMessageDelayMs } from "./burstScheduler";

test("a later message extends the burst and flushes once", () => {
  const scheduler = new BurstScheduler(3000);
  scheduler.push("user-a", 0);
  assert.deepEqual(scheduler.flush(2999), []);

  scheduler.push("user-a", 1000);
  assert.deepEqual(scheduler.flush(3000), []);
  assert.deepEqual(scheduler.flush(4000), ["user-a"]);
  assert.deepEqual(scheduler.flush(5000), []);
});

test("different users flush independently", () => {
  const scheduler = new BurstScheduler(3000);
  scheduler.push("user-a", 0);
  scheduler.push("user-b", 1000);
  assert.deepEqual(scheduler.flush(3000).sort(), ["user-a"]);
  assert.deepEqual(scheduler.flush(4000), ["user-b"]);
});

test("inter-message delay stays inside the natural range", () => {
  for (let index = 0; index < 200; index += 1) {
    const delay = interMessageDelayMs(() => index / 200);
    assert.ok(delay >= 700 && delay <= 1800);
  }
  assert.equal(interMessageDelayMs(() => 0), 700);
  assert.equal(interMessageDelayMs(() => 0.999999), 1800);
});

test("the timer resets for the same user and runs different users separately", async () => {
  const calls: string[] = [];
  const timer = createBurstTimer(40, (userId) => {
    calls.push(userId);
  });

  timer.push("user-a");
  await delay(15);
  timer.push("user-a");
  timer.push("user-b");
  await delay(30);
  assert.deepEqual(calls, []);

  await delay(30);
  assert.deepEqual(calls.sort(), ["user-a", "user-b"]);
  await delay(50);
  assert.equal(calls.length, 2);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
