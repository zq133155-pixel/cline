/**
 * 干预效果评估器 (Intervention Effect Evaluator)
 *
 * 职责：
 * 1. 在每次教学干预触发时，拍下"干预前"行为快照，并开启观察窗口
 * 2. 在观察窗口期间，持续接收行为事件，跟踪干预后的行为变化
 * 3. 窗口关闭后，拍"干预后"快照，计算行为 delta，判定效果
 * 4. 生成结构化的评估结果，交由外部持久化
 *
 * 设计原则：
 * - 事件驱动：通过 ingest() 被动接收事件，不主动轮询
 * - 低耦合：不直接依赖 BehaviorMonitor / TeachingInterventionManager 实例，
 *   只依赖它们产出的数据（InterventionMessage + StudentInteractionLog）
 * - 非阻塞：所有计算都是同步轻量操作，不影响主对话性能
 * - 多会话并行：支持同一任务内多次干预的独立评估
 */

import { Logger } from "@/shared/services/Logger"
import type {
	BehaviorDelta,
	BehaviorSnapshot,
	EvaluationOutcome,
	EvaluationSession,
	InterventionEvaluationLog,
	InterventionEvaluatorOptions,
	InterventionMessage,
	StudentInteractionLog,
} from "./types"

//======================== 默认配置 ========================

const DEFAULT_OPTIONS: Required<InterventionEvaluatorOptions> = {
	enabled: true,
	observationWindowSize: 8, // 观察窗口收集 8 条事件后再评估
	observationTimeoutMs: 10 * 60 * 1000, // 10 分钟超时
	improvedThreshold: 0.25, // improvementScore >= 0.25 判定为 improved
	noEffectThreshold: -0.1, // improvementScore <= -0.1 判定为 no_effect
	maxConcurrentSessions: 5, // 最多 5 个并行评估会话
}

// ======================== 工具函数 ========================

let sessionCounter = 0

function generateSessionId(taskId: string): string {
	sessionCounter++
	return `eval_${taskId}_${Date.now()}_${sessionCounter}`
}

// ======================== 评估器主类 ========================

export class InterventionEvaluator {
	private readonly taskId: string
	private readonly options: Required<InterventionEvaluatorOptions>

	/** 活跃评估会话（观察窗口尚未关闭） */
	private activeSessions: Map<string, EvaluationSession> = new Map()

	/** 已完成的评估会话（保留用于查询和统计） */
	private completedSessions: EvaluationSession[] = []

	/** 待持久化的评估日志队列 */
	private pendingEvaluationLogs: InterventionEvaluationLog[] = []

	/** 超时定时器 */
	private timeoutTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()

	constructor(taskId: string, options?: InterventionEvaluatorOptions) {
		this.taskId = taskId
		this.options = { ...DEFAULT_OPTIONS, ...options }
	}

	// ======================== 公共 API ========================

	/**
	 * 启动评估会话 — 在教学干预触发时调用
	 *
	 * @param intervention 刚注入的干预消息
	 * @param currentSnapshot 干预触发瞬间的行为快照
	 * @returns 会话 ID（null 表示未启动，如已达上限或未启用）
	 */
	public startEvaluation(intervention: InterventionMessage, currentSnapshot: BehaviorSnapshot): string | null {
		if (!this.options.enabled) {
			return null
		}

		// 检查并行会话数限制
		if (this.activeSessions.size >= this.options.maxConcurrentSessions) {
			Logger.info(
				`[InterventionEvaluator][${this.taskId}] skipped: max concurrent sessions reached (${this.activeSessions.size}/${this.options.maxConcurrentSessions})`,
			)
			return null
		}

		const sessionId = generateSessionId(this.taskId)

		const session: EvaluationSession = {
			sessionId,
			taskId: this.taskId,
			ruleId: intervention.ruleId,
			severity: intervention.severity,
			style: intervention.style,
			preSnapshot: { ...currentSnapshot },
			postSnapshot: null,
			observationWindowSize: this.options.observationWindowSize,
			observedEventCount: 0,
			outcome: null,
			confidence: 0,
			behaviorDelta: null,
			startedAt: new Date().toISOString(),
			completedAt: null,
		}

		this.activeSessions.set(sessionId, session)

		// 设置超时定时器
		const timer = setTimeout(() => {
			this.finalizeSession(sessionId, "timeout")
		}, this.options.observationTimeoutMs)
		this.timeoutTimers.set(sessionId, timer)

		Logger.info(
			`[InterventionEvaluator][${this.taskId}] evaluation started: sessionId=${sessionId}, rule=${intervention.ruleId}, windowSize=${this.options.observationWindowSize}`,
		)

		return sessionId
	}

	/**
	 * 摄入行为事件 — 由 Task.monitorBehavior() 旁路调用
	 *
	 * 将事件分发到所有活跃的评估会话中，
	 * 当某个会话的观察窗口收集到足够事件时自动完成评估
	 */
	public ingest(event: StudentInteractionLog): void {
		if (!this.options.enabled || this.activeSessions.size === 0) {
			return
		}

		// 只关注本任务的事件
		if (event.taskId !== this.taskId) {
			return
		}

		// 分发到所有活跃会话
		for (const [sessionId, session] of this.activeSessions) {
			this.feedEventToSession(session, event)

			// 检查观察窗口是否已满
			if (session.observedEventCount >= session.observationWindowSize) {
				this.finalizeSession(sessionId, "window_complete")
			}
		}
	}

	/**
	 * 消费待持久化的评估日志（获取并清空队列）
	 */
	public consumePendingEvaluationLogs(): InterventionEvaluationLog[] {
		const logs = [...this.pendingEvaluationLogs]
		this.pendingEvaluationLogs = []
		return logs
	}

	/**
	 * 是否有待持久化的评估日志
	 */
	public hasPendingEvaluationLogs(): boolean {
		return this.pendingEvaluationLogs.length > 0
	}

	/**
	 * 获取所有已完成的评估会话
	 */
	public getCompletedSessions(): ReadonlyArray<EvaluationSession> {
		return this.completedSessions
	}

	/**
	 * 获取当前活跃的评估会话数
	 */
	public getActiveSessionCount(): number {
		return this.activeSessions.size
	}

	/**
	 * 获取效果统计摘要
	 */
	public getEffectSummary(): { improved: number; neutral: number; no_effect: number; total: number } {
		const summary = { improved: 0, neutral: 0, no_effect: 0, total: this.completedSessions.length }
		for (const session of this.completedSessions) {
			if (session.outcome === "improved") summary.improved++
			else if (session.outcome === "neutral") summary.neutral++
			else if (session.outcome === "no_effect") summary.no_effect++
		}
		return summary
	}

	/**
	 * 清理所有状态（任务结束时调用）
	 */
	public dispose(): void {
		// 强制完成所有活跃会话
		for (const sessionId of this.activeSessions.keys()) {
			this.finalizeSession(sessionId, "task_end")
		}
		// 清除所有定时器
		for (const timer of this.timeoutTimers.values()) {
			clearTimeout(timer)
		}
		this.timeoutTimers.clear()
	}

	// ======================== 内部方法 ========================

	/**
	 * 将事件喂入某个评估会话，更新该会话的观察计数器和快照数据
	 */
	private feedEventToSession(session: EvaluationSession, event: StudentInteractionLog): void {
		session.observedEventCount++

		// 动态构建 postSnapshot — 随着事件摄入逐步更新
		if (!session.postSnapshot) {
			session.postSnapshot = {
				ts: event.ts,
				assistantCodeStreak: 0,
				turnsSinceLastEdit: session.preSnapshot.turnsSinceLastEdit, // 继承干预前状态
				codeEditCount: 0,
				assistantCodeTurnCount: 0,
				userTurnCount: 0,
				turnIndex: event.turnIndex,
			}
		}

		const snap = session.postSnapshot
		snap.ts = event.ts // 更新为最新事件时间
		snap.turnIndex = event.turnIndex

		switch (event.eventType) {
			case "code_edit":
				snap.codeEditCount++
				snap.turnsSinceLastEdit = 0 // 有编辑行为，重置无编辑计数
				snap.assistantCodeStreak = 0 // 学生有自己动手，适当重置连续代码生成计数
				break

			case "turn_message":
				if (event.role === "assistant") {
					if (event.hasCode) {
						snap.assistantCodeTurnCount++
						snap.assistantCodeStreak++
					} else {
						snap.assistantCodeStreak = 0
					}
					snap.turnsSinceLastEdit++
				} else if (event.role === "user") {
					snap.userTurnCount++
					snap.turnsSinceLastEdit++
				}
				break

			case "file_save":
				// 文件保存也视为一种积极的自主行为
				snap.codeEditCount++
				break

			default:
				// adoption_infer 等其他事件只计数，不影响快照指标
				break
		}
	}

	/**
	 * 完成某个评估会话：计算 delta → 判定 outcome → 生成日志 → 归档
	 */
	private finalizeSession(sessionId: string, reason: "window_complete" | "timeout" | "task_end"): void {
		const session = this.activeSessions.get(sessionId)
		if (!session) {
			return
		}

		// 清除超时定时器
		const timer = this.timeoutTimers.get(sessionId)
		if (timer) {
			clearTimeout(timer)
			this.timeoutTimers.delete(sessionId)
		}

		// 确保 postSnapshot 存在（可能零事件直接超时）
		if (!session.postSnapshot) {
			session.postSnapshot = {
				ts: new Date().toISOString(),
				assistantCodeStreak: session.preSnapshot.assistantCodeStreak,
				turnsSinceLastEdit: session.preSnapshot.turnsSinceLastEdit,
				codeEditCount: 0,
				assistantCodeTurnCount: 0,
				userTurnCount: 0,
				turnIndex: session.preSnapshot.turnIndex,
			}
		}

		// 计算行为 delta
		const delta = this.calculateBehaviorDelta(session.preSnapshot, session.postSnapshot)
		session.behaviorDelta = delta

		// 判定效果 + 置信度
		const { outcome, confidence } = this.evaluateOutcome(delta, session.observedEventCount, reason)
		session.outcome = outcome
		session.confidence = confidence
		session.completedAt = new Date().toISOString()

		// 生成持久化日志
		const evaluationLog = this.buildEvaluationLog(session)
		this.pendingEvaluationLogs.push(evaluationLog)

		// 归档
		this.activeSessions.delete(sessionId)
		this.completedSessions.push(session)

		Logger.info(
			`[InterventionEvaluator][${this.taskId}] evaluation completed: sessionId=${sessionId}, ` +
				`reason=${reason}, outcome=${outcome}, confidence=${confidence.toFixed(2)}, ` +
				`improvementScore=${delta.improvementScore.toFixed(3)}, ` +
				`events=${session.observedEventCount}/${session.observationWindowSize}`,
		)
	}

	/**
	 * 计算干预前后的行为 Delta
	 *
	 * 核心指标及权重设计：
	 * - codeStreakDelta:  连续代码生成减少 → 正面信号（权重 0.3）
	 * - noEditStreakDelta: 无编辑轮次减少 → 正面信号（权重 0.2）
	 * - codeEditDelta:   代码编辑增加 → 正面信号（权重 0.35）
	 * - userTurnDelta:   用户主动发言增加 → 正面信号（权重 0.15）
	 */
	private calculateBehaviorDelta(pre: BehaviorSnapshot, post: BehaviorSnapshot): BehaviorDelta {
		const codeStreakDelta = post.assistantCodeStreak - pre.assistantCodeStreak
		const noEditStreakDelta = post.turnsSinceLastEdit - pre.turnsSinceLastEdit
		const codeEditDelta = post.codeEditCount // post 是窗口内的增量，pre 时为0
		const userTurnDelta = post.userTurnCount

		// 计算各维度的归一化改善信号 (-1 到 1)
		// 连续代码生成：减少是好事
		const codeStreakSignal =
			codeStreakDelta <= 0
				? Math.min(-codeStreakDelta / Math.max(pre.assistantCodeStreak, 1), 1)
				: -Math.min(codeStreakDelta / Math.max(pre.assistantCodeStreak, 1), 1)

		// 无编辑轮次：减少是好事
		const noEditSignal =
			noEditStreakDelta <= 0
				? Math.min(-noEditStreakDelta / Math.max(pre.turnsSinceLastEdit, 1), 1)
				: -Math.min(noEditStreakDelta / Math.max(pre.turnsSinceLastEdit, 1), 1)

		// 代码编辑数：增加是好事（基于观察窗口大小归一化）
		const codeEditSignal = Math.min(codeEditDelta / Math.max(post.assistantCodeTurnCount, 1), 1)

		// 用户主动发言：增加是好事
		const userTurnSignal = Math.min(userTurnDelta / Math.max(this.options.observationWindowSize / 2, 1), 1)

		// 加权汇总
		const improvementScore = codeStreakSignal * 0.3 + noEditSignal * 0.2 + codeEditSignal * 0.35 + userTurnSignal * 0.15

		return {
			codeStreakDelta,
			noEditStreakDelta,
			codeEditDelta,
			userTurnDelta,
			improvementScore: Math.max(-1, Math.min(1, improvementScore)), // clamp to [-1, 1]
		}
	}

	/**
	 * 根据 improvementScore 和观察数据质量判定效果
	 *
	 * 置信度计算：
	 * - 基础置信度由观察事件数决定（越多越可靠）
	 * - 超时结束的会话置信度打折（数据不完整）
	 * - 事件数极少时置信度很低
	 */
	private evaluateOutcome(
		delta: BehaviorDelta,
		observedCount: number,
		reason: string,
	): { outcome: EvaluationOutcome; confidence: number } {
		// 基础置信度：观察事件数 / 预期窗口大小
		let confidence = Math.min(observedCount / this.options.observationWindowSize, 1)

		// 超时或任务结束时打折
		if (reason === "timeout") {
			confidence *= 0.7
		} else if (reason === "task_end") {
			confidence *= 0.5
		}

		// 事件数极少时进一步降低置信度
		if (observedCount <= 2) {
			confidence *= 0.4
		}

		// 判定效果
		let outcome: EvaluationOutcome
		if (delta.improvementScore >= this.options.improvedThreshold) {
			outcome = "improved"
		} else if (delta.improvementScore <= this.options.noEffectThreshold) {
			outcome = "no_effect"
		} else {
			outcome = "neutral"
		}

		return { outcome, confidence: Math.max(0, Math.min(1, confidence)) }
	}

	/**
	 * 构建持久化评估日志
	 */
	private buildEvaluationLog(session: EvaluationSession): InterventionEvaluationLog {
		const startTime = new Date(session.startedAt).getTime()
		const endTime = session.completedAt ? new Date(session.completedAt).getTime() : Date.now()

		return {
			ts: session.completedAt ?? new Date().toISOString(),
			taskId: session.taskId,
			eventType: "intervention_evaluation",
			sessionId: session.sessionId,
			ruleId: session.ruleId,
			severity: session.severity,
			style: session.style,
			outcome: session.outcome!,
			confidence: session.confidence,
			preSnapshot: session.preSnapshot,
			postSnapshot: session.postSnapshot!,
			behaviorDelta: session.behaviorDelta!,
			observedEventCount: session.observedEventCount,
			evaluationDurationMs: endTime - startTime,
		}
	}

	// ======================== 快照辅助方法 ========================

	/**
	 * 从 BehaviorMonitor 的当前状态创建行为快照
	 *
	 * 由外部调用（Task 层），传入 monitor 的实时指标
	 * 这样 Evaluator 无需直接引用 BehaviorMonitor，保持低耦合
	 */
	public static createSnapshotFromMetrics(
		assistantCodeStreak: number,
		turnsSinceLastEdit: number,
		turnIndex: number,
	): BehaviorSnapshot {
		return {
			ts: new Date().toISOString(),
			assistantCodeStreak,
			turnsSinceLastEdit,
			codeEditCount: 0,
			assistantCodeTurnCount: 0,
			userTurnCount: 0,
			turnIndex,
		}
	}
}
