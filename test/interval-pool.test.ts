import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTERVAL_CONTESTANTS, MAX_DRAW_ATTEMPTS, drawInterval, exactWinningProbabilities,
  normalizePoolState, renderDraw, type IntervalPoolState,
} from "../src/proactive/interval-pool.js";

function sequence(values: number[]) {
  let calls = 0;
  const rng = () => {
    const value = values[calls++];
    if (value === undefined) throw new Error("Fixture RNG exhausted");
    return value;
  };
  return { rng, calls: () => calls };
}

const impatientWins = () => sequence([0.9, 0.1, 0.1, 0.1, 0.1]);

test("时间池：固定五位选手及原始分钟/权重，不允许运行时改写", () => {
  assert.deepEqual(INTERVAL_CONTESTANTS.map(({ name, intervalMinutes, weight }) => [name, intervalMinutes, weight]), [
    ["急急星人", 5, 3], ["碎碎念", 15, 3], ["摸鱼怪", 30, 2], ["按月考勤", 60, 2], ["幽灵船员", 240, 1],
  ]);
  assert.equal(Object.isFrozen(INTERVAL_CONTESTANTS), true);
  assert.ok(INTERVAL_CONTESTANTS.every(Object.isFrozen));
});

test("时间池：每人独立同时摇U*权重，以最高实际点数取胜，不是按权重抽签", () => {
  const dice = sequence([0.2, 0.1, 0.3, 0.8, 0.9]);
  const draw = drawInterval(undefined, dice.rng);
  assert.equal(dice.calls(), 5);
  assert.equal(draw.winner.id, "monthly");
  assert.equal(draw.nextIntervalMinutes, 60);
  assert.equal(draw.round, 1);
  assert.equal(draw.attempts, 1);
  assert.deepEqual(draw.contestants.map(roll => roll.rawDice), [0.2, 0.1, 0.3, 0.8, 0.9]);
  assert.deepEqual(draw.contestants.map(roll => roll.effectiveWeight), [3, 3, 2, 2, 1]);
  assert.equal(draw.contestants[3]!.score, 1.6);
  assert.equal(draw.contestants[4]!.score, 0.9);
  assert.deepEqual(draw.nextState, { round: 1, lastWinnerId: "monthly", consecutiveWins: 1 });
});

test("时间池：幽灵船员的权重虽小仍能凭实际最高点赢得240分钟", () => {
  const draw = drawInterval(undefined, sequence([0.1, 0.1, 0.1, 0.1, 0.9]).rng);
  assert.equal(draw.winner.id, "ghost");
  assert.equal(draw.nextIntervalMinutes, 240);
});

test("时间池：真正最高点平手时全员重摇，第三人可在重摇后取胜", () => {
  const dice = sequence([0.5, 0.5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.8, 0.1, 0.1]);
  const draw = drawInterval(undefined, dice.rng);
  assert.equal(dice.calls(), 10);
  assert.equal(draw.attempts, 2);
  assert.equal(draw.winner.id, "slacker");
  assert.equal(draw.round, 1, "平手尝试不增加正式轮数");
  assert.deepEqual(draw.contestants.map(roll => roll.rawDice), [0.1, 0.1, 0.8, 0.1, 0.1]);
});

test("时间池：非最高选手点数相同不算平手；极接近的最高点也不重摇", () => {
  const lowerTie = sequence([0.9, 0.1, 0.15, 0.15, 0.3]);
  assert.equal(drawInterval(undefined, lowerTie.rng).attempts, 1);
  assert.equal(lowerTie.calls(), 5);
  const close = sequence([0.5, 0.5 + Number.EPSILON, 0.1, 0.1, 0.1]);
  const draw = drawInterval(undefined, close.rng);
  assert.equal(draw.winner.id, "chatterbox");
  assert.equal(draw.attempts, 1);
  assert.equal(close.calls(), 5);
  const shown = renderDraw(draw).split("\n").filter(line => line.includes("权重"))
    .map(line => Number(line.split("：").at(-1)));
  assert.ok(shown[1]! > shown[0]!, "公告自动提高精度，不能把不同的最高点四舍五入成平手");
});

test("时间池：常量RNG导致无穷平手时最多50次后报错，原状态不变", () => {
  const state: IntervalPoolState = { round: 1, lastWinnerId: "ghost", consecutiveWins: 1 };
  let calls = 0;
  assert.throws(() => drawInterval(state, () => { calls++; return 0.5; }), /remained tied after 50 attempts/);
  assert.equal(calls, MAX_DRAW_ATTEMPTS * 5);
  assert.deepEqual(state, { round: 1, lastWinnerId: "ghost", consecutiveWins: 1 });
});

test("时间池：0是合法随机值，所有人0必须重摇；拒绝越界、NaN和非数字", () => {
  const draw = drawInterval(undefined, sequence([0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0]).rng);
  assert.equal(draw.attempts, 2);
  assert.equal(draw.winner.id, "chatterbox");
  for (const value of [-0.01, 1, Infinity, -Infinity, NaN, "0.5", undefined, null]) {
    assert.throws(() => drawInterval(undefined, () => value as number), /finite number in \[0, 1\)/);
  }
  assert.throws(() => drawInterval(undefined, null as unknown as () => number), /RNG must be a function/);
});

test("时间池：同一选手连赢两轮后，第三轮只把它的权重减半", () => {
  const first = drawInterval(undefined, impatientWins().rng);
  const second = drawInterval(first.nextState, impatientWins().rng);
  assert.equal(first.nextState.consecutiveWins, 1);
  assert.equal(second.nextState.consecutiveWins, 2);
  assert.equal(second.contestants[0]!.effectiveWeight, 3);
  const third = drawInterval(second.nextState, sequence([0.8, 0.5, 0.1, 0.1, 0.1]).rng);
  assert.deepEqual(third.contestants.map(roll => roll.effectiveWeight), [1.5, 3, 2, 2, 1]);
  assert.equal(third.winner.id, "chatterbox", "急急星人原本2.4分被减半至1.2，输给碎碎念1.5分");
  assert.deepEqual(third.nextState, { round: 3, lastWinnerId: "chatterbox", consecutiveWins: 1 });
  assert.deepEqual(second.nextState, { round: 2, lastWinnerId: "impatient", consecutiveWins: 2 });
});

test("时间池：受罚选手第三轮照样赢时，胜后清除惩罚并重新累计连胜", () => {
  const state: IntervalPoolState = { round: 2, lastWinnerId: "impatient", consecutiveWins: 2 };
  const third = drawInterval(state, impatientWins().rng);
  assert.equal(third.winner.id, "impatient");
  assert.equal(third.winner.effectiveWeight, 1.5);
  assert.deepEqual(third.nextState, { round: 3, lastWinnerId: null, consecutiveWins: 0 });
  const fourth = drawInterval(third.nextState, impatientWins().rng);
  assert.equal(fourth.winner.effectiveWeight, 3);
  assert.equal(fourth.nextState.consecutiveWins, 1);
  assert.equal(fourth.nextState.round, 4);
});

test("时间池：被其他赢家打断后，之前的连胜和减半状态不延续", () => {
  const state: IntervalPoolState = { round: 2, lastWinnerId: "impatient", consecutiveWins: 2 };
  const broken = drawInterval(state, sequence([0.1, 0.9, 0.1, 0.1, 0.1]).rng);
  const after = drawInterval(broken.nextState, impatientWins().rng);
  assert.equal(after.winner.effectiveWeight, 3);
  assert.deepEqual(after.nextState, { round: 4, lastWinnerId: "impatient", consecutiveWins: 1 });
});

test("时间池：状态严格校验并返回克隆，损坏状态不能部分污染新状态", () => {
  assert.deepEqual(normalizePoolState(), { round: 0, lastWinnerId: null, consecutiveWins: 0 });
  assert.deepEqual(normalizePoolState(null), normalizePoolState());
  const original: IntervalPoolState = { round: 9, lastWinnerId: "monthly", consecutiveWins: 2 };
  const cloned = normalizePoolState(JSON.parse(JSON.stringify(original)));
  assert.deepEqual(cloned, original);
  assert.notEqual(normalizePoolState(original), original);
  cloned.round = 100;
  assert.equal(original.round, 9);
  for (const state of [
    {}, [], "state", { round: -1, lastWinnerId: null, consecutiveWins: 0 },
    { round: 1.2, lastWinnerId: null, consecutiveWins: 0 },
    { round: Number.MAX_SAFE_INTEGER + 1, lastWinnerId: null, consecutiveWins: 0 },
    { round: 2, lastWinnerId: "unknown", consecutiveWins: 2 },
    { round: 2, lastWinnerId: "impatient", consecutiveWins: 3 },
    { round: 2, lastWinnerId: "impatient", consecutiveWins: 0 },
    { round: 2, lastWinnerId: null, consecutiveWins: 1 },
    { round: 1, lastWinnerId: "impatient", consecutiveWins: 2 },
    { ...original, extra: true },
  ]) assert.throws(() => normalizePoolState(state), /Invalid interval pool state/);
});

test("时间池：积分计算的是最高骰点胜率，基础胜率与精确分数一致", () => {
  const probabilities = exactWinningProbabilities();
  const expected = [31 / 80, 31 / 80, 79 / 720, 79 / 720, 1 / 180];
  probabilities.forEach((entry, i) => assert.ok(Math.abs(entry.probability - expected[i]!) < 1e-12));
  assert.ok(Math.abs(probabilities.reduce((sum, entry) => sum + entry.probability, 0) - 1) < 1e-12);
  assert.equal(probabilities[0]!.probability, probabilities[1]!.probability);
  assert.ok(probabilities[0]!.probability > 3 / 11, "最高骰点概率不能错误当成普通权重抽签3/11");
});

test("时间池：胜率积分使用连胜后的实际权重，恢复后回到基础概率", () => {
  const state: IntervalPoolState = { round: 2, lastWinnerId: "impatient", consecutiveWins: 2 };
  const base = exactWinningProbabilities();
  const penalized = exactWinningProbabilities(state);
  assert.equal(penalized[0]!.effectiveWeight, 1.5);
  assert.ok(penalized[0]!.probability < base[0]!.probability);
  assert.ok(penalized[1]!.probability > base[1]!.probability);
  assert.ok(Math.abs(penalized.reduce((sum, entry) => sum + entry.probability, 0) - 1) < 1e-12);
  const win = drawInterval(state, impatientWins().rng);
  assert.deepEqual(exactWinningProbabilities(win.nextState), base);
});

test("时间池：五位选手各自受罚时仍是有限完整概率分布，只减少自己的胜率", () => {
  const base = exactWinningProbabilities();
  INTERVAL_CONTESTANTS.forEach((contestant, index) => {
    const state: IntervalPoolState = { round: 2, lastWinnerId: contestant.id, consecutiveWins: 2 };
    const probabilities = exactWinningProbabilities(state);
    assert.equal(probabilities[index]!.effectiveWeight, contestant.weight / 2);
    assert.ok(probabilities[index]!.probability < base[index]!.probability);
    assert.ok(probabilities.every(entry => Number.isFinite(entry.probability) && entry.probability > 0 && entry.probability < 1));
    assert.ok(Math.abs(probabilities.reduce((sum, entry) => sum + entry.probability, 0) - 1) < 1e-12);
  });
});

test("时间池：公告模板覆盖五人和本轮减半，渲染不再消耗骰子或修改记录", () => {
  const state: IntervalPoolState = { round: 2, lastWinnerId: "impatient", consecutiveWins: 2 };
  const dice = impatientWins();
  const draw = drawInterval(state, dice.rng);
  const before = JSON.stringify(draw);
  const announcement = renderDraw(draw);
  for (const contestant of INTERVAL_CONTESTANTS) assert.ok(announcement.includes(contestant.name));
  assert.match(announcement, /3 → 1\.5，连胜减半/);
  assert.match(announcement, /第 3 轮/);
  assert.match(announcement, /下次 5 分钟后/);
  assert.ok(announcement.split("\n").filter(line => line.includes("权重"))
    .every(line => /：\d+\.\d{2}$/.test(line)), "普通点数用两位小数显示");
  assert.notEqual(renderDraw(draw, 0), renderDraw(draw, 1));
  assert.equal(dice.calls(), 5);
  assert.equal(JSON.stringify(draw), before);
});

test("时间池：平手后的公告说明重摇，而不是宣称同分时随意挑选", () => {
  const draw = drawInterval(undefined, sequence([0.5, 0.5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.8, 0.1, 0.1]).rng);
  assert.match(renderDraw(draw), /最高点平手.*全员重摇 1 次/);
});
