// lib/reminder.js —— 回合末「提醒沉淀」门控（纯函数 + 状态机，可单测）
//
// 设计要点（来自实测教训）：
// - 提醒走独立收尾回合（agent.followup），不用同回合 steer，避免折叠原任务答案；
// - 收尾回合打标 isDistillRound：不递归触发、不计入 every 频率，回合结束自动复位；
// - 只提醒“有效工作回合”（有工具调用、非 idle/aborted、非 subagent）。

/** 默认提醒词（可 config.reminderPrompt 覆盖）。 */
export const DEFAULT_REMINDER = [
  "【经验沉淀 · 收尾】请回顾刚结束的回合，按记忆纪律提炼 0–3 条可复用经验：",
  "踩过的坑与根因、验证过的命令/参数/路径、方案取舍、环境事实、用户偏好。",
  "有就用 write/edit 追加到记忆目录 topics/ 对应分片（格式 `- [YYYY-MM-DD] **短标题** —— 结论`，单条 ≤400 字，写前查重），",
  "没有就直接回答「本轮无需沉淀」。绝不写密钥；不写流水账。完成后回报“本轮沉淀 N 条”。",
].join("\n");

/**
 * 门控判定（AND 条件，纯函数）。
 * @param {object} s 回合状态：
 *   outcome: "worked"|"idle"|"aborted"；
 *   toolCalls 本回合工具调用数；sedimentedThisTurn 本回合是否已写过记忆；
 *   isDistillRound 当前回合是否为提醒收尾回合；isSubagent 是否子代理；
 *   workedSinceRemind 距上次提醒之间经历的有效回合数（含本回合）；lastRemindAt 上次提醒时间戳(ms)。
 * @param {object} cfg 配置：autoDistill / every / cooldownMin / minTools / skipSubagents。
 * @param {number} now 当前时间戳(ms)。
 * @returns {{remind:boolean, reason:string}}
 */
export function evaluateTurn(s, cfg = {}, now = Date.now()) {
  const every = Math.max(1, Number(cfg.every ?? 1));
  const cooldownMin = Math.max(0, Number(cfg.cooldownMin ?? 0));
  const minTools = Math.max(0, Number(cfg.minTools ?? 1));
  const skipSubagents = cfg.skipSubagents !== false;

  if (cfg.autoDistill === false) return { remind: false, reason: "autoDistill 关闭" };
  if (s.isDistillRound) return { remind: false, reason: "收尾回合不再递归" };
  if (s.sedimentedThisTurn) return { remind: false, reason: "本回合已沉淀" };
  if (skipSubagents && s.isSubagent) return { remind: false, reason: "跳过 subagent" };
  if (s.outcome !== "worked") return { remind: false, reason: `回合结局 ${s.outcome ?? "未知"}，非有效工作回合` };
  if ((s.toolCalls ?? 0) < minTools) return { remind: false, reason: `工具调用 ${s.toolCalls ?? 0} < minTools ${minTools}` };
  if ((s.workedSinceRemind ?? 0) < every) return { remind: false, reason: `worked 计数未到 every=${every}` };
  if (cooldownMin > 0 && Number.isFinite(s.lastRemindAt) && now - s.lastRemindAt < cooldownMin * 60000) {
    return { remind: false, reason: `冷却中（${cooldownMin} 分钟）` };
  }
  return { remind: true, reason: "满足全部条件" };
}

/**
 * 回合状态机（按 agent 隔离）。只依赖事件 type 字符串，不依赖宿主内部结构。
 */
export class TurnTracker {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.agents = new Map();
  }

  stateOf(agentId) {
    if (!this.agents.has(agentId)) {
      this.agents.set(agentId, {
        inTurn: false,
        outcome: "idle",
        toolCalls: 0,
        sedimentedThisTurn: false,
        isDistillRound: false,
        isSubagent: false,
        workedSinceRemind: 0,
        lastRemindAt: NaN,
      });
    }
    return this.agents.get(agentId);
  }

  setSubagent(agentId, isSubagent) {
    this.stateOf(agentId).isSubagent = Boolean(isSubagent);
  }

  /** 记忆写入落盘后由钩子调用（比事件猜测可靠）。 */
  markSedimented(agentId) {
    this.stateOf(agentId).sedimentedThisTurn = true;
  }

  /** 实际派出 followup 收尾回合时调用：打标 + 计数复位。 */
  dispatched(agentId, now = Date.now()) {
    const s = this.stateOf(agentId);
    s.isDistillRound = true;
    s.workedSinceRemind = 0;
    s.lastRemindAt = now;
  }

  /**
   * 喂一个会话事件。
   * @returns {null|{remind:boolean, reason:string, state:object}} turn/end 时返回判定结果。
   */
  feed(agentId, event, now = Date.now()) {
    const s = this.stateOf(agentId);
    const type = String(event?.type ?? "");

    if (type === "turn/start") {
      s.inTurn = true;
      s.outcome = "worked";
      s.toolCalls = 0;
      s.sedimentedThisTurn = false;
      return null;
    }
    if (type === "tool/call") {
      s.toolCalls += 1;
      return null;
    }
    if (type === "user/aborted") {
      s.outcome = "aborted";
      return null;
    }
    if (type === "turn/end") {
      s.inTurn = false;
      const wasDistill = s.isDistillRound;
      if (!wasDistill && s.outcome === "worked") s.workedSinceRemind += 1;
      const verdict = evaluateTurn(s, this.cfg, now);
      if (wasDistill) s.isDistillRound = false; // 收尾回合结束，恢复正常
      return { ...verdict, state: s };
    }
    return null;
  }
}
