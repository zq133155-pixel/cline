/**
 * 学生能力画像生成器
 * Student Profile Generator
 *
 * 基于 student_interactions.log 日志数据，计算各维度能力指标并推断学习风格。
 * 纯计算模块，不引入数据库或 UI，仅做离线分析使用。
 */

import type { LearningStyle, StudentInteractionLog, StudentProfile, TaskCategory } from "./types"

/** 所有可用 category（与 TaskCategory 枚举对齐） */
const ALL_CATEGORIES: TaskCategory[] = [
	"algorithm",
	"debugging",
	"explanation",
	"language_request",
	"code_generation",
	"refactoring",
	"testing",
	"other",
]

/**
 * StudentProfiler — 从原始日志条目生成结构化 StudentProfile。
 *
 * 使用方式：
 * ```ts
 * const profiler = new StudentProfiler(logs)
 * const profile = profiler.generate()
 * ```
 */
export class StudentProfiler {
	private readonly logs: StudentInteractionLog[]

	constructor(logs: StudentInteractionLog[]) {
		this.logs = logs
	}

	// ===================== public API =====================

	/**
	 * 生成完整的学生画像
	 */
	generate(): StudentProfile {
		const conversationLogs = this.logs.filter((l) => l.eventType === "task_start" || l.eventType === "turn_message")
		const userTurns = conversationLogs.filter((l) => l.role === "user")
		const assistantTurns = conversationLogs.filter((l) => l.role === "assistant")
		const codeEdits = this.logs.filter((l) => l.eventType === "code_edit")
		const adoptionLogs = this.logs.filter((l) => l.eventType === "adoption_infer")

		const uniqueTaskIds = new Set(this.logs.map((l) => l.taskId))
		const totalTasks = uniqueTaskIds.size

		// ---- 基础指标 ----
		const avgTurnsPerTask = this.calcAvgTurnsPerTask(conversationLogs, totalTasks)
		const aiDependencyScore = this.calcAiDependency(userTurns.length, assistantTurns.length)
		const codeEditRatio = this.calcCodeEditRatio(codeEdits.length, assistantTurns)
		const adoptionRate = this.calcAdoptionRate(adoptionLogs)
		const selfModificationRate = this.calcSelfModificationRate(codeEdits, assistantTurns, uniqueTaskIds)
		const debuggingFrequency = this.calcDebuggingFrequency(conversationLogs)
		const explorationBreadth = this.calcExplorationBreadth(conversationLogs)
		const dominantCategory = this.calcDominantCategory(conversationLogs)

		// ---- 时间范围 ----
		const timestamps = this.logs
			.map((l) => l.ts)
			.filter(Boolean)
			.sort()
		const timeRange = {
			start: timestamps[0] || "",
			end: timestamps[timestamps.length - 1] || "",
		}

		// ---- 学习风格推断 ----
		const { style, confidence } = this.inferLearningStyle({
			aiDependencyScore,
			codeEditRatio,
			adoptionRate,
			selfModificationRate,
			debuggingFrequency,
			explorationBreadth,
			avgTurnsPerTask,
			dominantCategory,
		})

		return {
			totalTasks,
			avgTurnsPerTask,
			totalInteractions: this.logs.length,
			aiDependencyScore,
			codeEditRatio,
			adoptionRate,
			selfModificationRate,
			debuggingFrequency,
			explorationBreadth,
			dominantCategory,
			learningStyle: style,
			styleConfidence: confidence,
			generatedAt: new Date().toISOString(),
			timeRange,
		}
	}

	// ===================== 指标计算 =====================

	/**
	 * AI 依赖度 = assistantTurns / (userTurns + assistantTurns)
	 * 值越高表示对话中 AI 占比越大。
	 */
	private calcAiDependency(userCount: number, assistantCount: number): number {
		const total = userCount + assistantCount
		return total > 0 ? assistantCount / total : 0
	}

	/**
	 * 代码编辑比 = code_edit 次数 / AI 含代码回复数
	 * 衡量"每次 AI 给出代码后，学生进行了多少编辑"。
	 * > 1 时说明学生在每次 AI 代码建议后做了多次修改。
	 * 为方便归一化，上限 clamp 到 1。
	 */
	private calcCodeEditRatio(codeEditCount: number, assistantTurns: StudentInteractionLog[]): number {
		const assistantWithCode = assistantTurns.filter((l) => l.hasCode).length
		if (assistantWithCode === 0) return 0
		const raw = codeEditCount / assistantWithCode
		return Math.min(raw, 1) // clamp to [0, 1]
	}

	/**
	 * AI 建议采纳率 = adopted / (adopted + rejected + continued)
	 * 排除 unknown，只看有明确判定的样本。
	 */
	private calcAdoptionRate(adoptionLogs: StudentInteractionLog[]): number {
		const determined = adoptionLogs.filter((l) => l.adoptionStatus && l.adoptionStatus !== "unknown")
		if (determined.length === 0) return 0
		const adopted = determined.filter((l) => l.adoptionStatus === "adopted").length
		return adopted / determined.length
	}

	/**
	 * 自主修改率 = 有 code_edit 事件的任务数 / 有 AI 代码输出的任务数
	 * 衡量学生收到 AI 代码后是否会自行动手修改。
	 */
	private calcSelfModificationRate(
		codeEdits: StudentInteractionLog[],
		assistantTurns: StudentInteractionLog[],
		uniqueTaskIds: Set<string>,
	): number {
		// 有 AI 代码输出的任务
		const tasksWithAiCode = new Set(assistantTurns.filter((l) => l.hasCode).map((l) => l.taskId))
		if (tasksWithAiCode.size === 0) return 0

		// 有 code_edit 的任务（并且也有 AI 代码输出）
		const tasksWithEdit = new Set(codeEdits.map((l) => l.taskId))
		let overlap = 0
		for (const tid of tasksWithEdit) {
			if (tasksWithAiCode.has(tid)) overlap++
		}

		return overlap / tasksWithAiCode.size
	}

	/**
	 * 调试频率 = debugging 类消息数 / 对话消息总数
	 */
	private calcDebuggingFrequency(conversationLogs: StudentInteractionLog[]): number {
		if (conversationLogs.length === 0) return 0
		const debugCount = conversationLogs.filter((l) => l.category === "debugging").length
		return debugCount / conversationLogs.length
	}

	/**
	 * 探索广度 = 学生实际涉及的不同 category 数 / 所有可用 category 数
	 */
	private calcExplorationBreadth(conversationLogs: StudentInteractionLog[]): number {
		const usedCategories = new Set(conversationLogs.map((l) => l.category).filter(Boolean))
		return usedCategories.size / ALL_CATEGORIES.length
	}

	/**
	 * 主导分类 = 出现次数最多的 category
	 */
	private calcDominantCategory(conversationLogs: StudentInteractionLog[]): TaskCategory | "unknown" {
		const freq: Record<string, number> = {}
		for (const log of conversationLogs) {
			const cat = log.category || "unknown"
			freq[cat] = (freq[cat] || 0) + 1
		}
		let maxCat: string = "unknown"
		let maxCount = 0
		for (const [cat, count] of Object.entries(freq)) {
			if (count > maxCount) {
				maxCount = count
				maxCat = cat
			}
		}
		return maxCat as TaskCategory | "unknown"
	}

	/**
	 * 平均每任务轮次数（取每个 task 的最大 turnIndex + 1）
	 */
	private calcAvgTurnsPerTask(conversationLogs: StudentInteractionLog[], totalTasks: number): number {
		if (totalTasks === 0) return 0
		const taskTurnMax = new Map<string, number>()
		for (const log of conversationLogs) {
			const cur = taskTurnMax.get(log.taskId) || 0
			taskTurnMax.set(log.taskId, Math.max(cur, (log.turnIndex || 0) + 1))
		}
		const totalTurns = Array.from(taskTurnMax.values()).reduce((s, v) => s + v, 0)
		return totalTurns / totalTasks
	}

	// ===================== 学习风格推断（规则引擎 v1） =====================

	/**
	 * 基于多维指标，使用加权评分规则推断学习风格。
	 *
	 * 每种风格独立计算一个匹配得分 (0–1)，最终取得分最高者。
	 * 若最高得分 < 0.3，回退为 "Balanced"。
	 */
	private inferLearningStyle(metrics: {
		aiDependencyScore: number
		codeEditRatio: number
		adoptionRate: number
		selfModificationRate: number
		debuggingFrequency: number
		explorationBreadth: number
		avgTurnsPerTask: number
		dominantCategory: string
	}): { style: LearningStyle; confidence: number } {
		const scores: Record<LearningStyle, number> = {
			Dependent: 0,
			Exploratory: 0,
			Optimizer: 0,
			Debugger: 0,
			Balanced: 0,
		}

		// ---- Dependent（依赖型）----
		// 高 AI 依赖 + 低自主修改 + 高采纳（被动接受）
		scores.Dependent =
			this.sigmoid(metrics.aiDependencyScore, 0.65, 10) * 0.4 +
			(1 - metrics.selfModificationRate) * 0.3 +
			(1 - metrics.codeEditRatio) * 0.3

		// ---- Exploratory（探索型）----
		// 多轮对话 + 类别广泛 + 高编辑比
		scores.Exploratory =
			this.sigmoid(metrics.avgTurnsPerTask, 4, 1) * 0.3 +
			metrics.explorationBreadth * 0.35 +
			metrics.codeEditRatio * 0.2 +
			metrics.selfModificationRate * 0.15

		// ---- Optimizer（优化型）----
		// 采纳 AI 建议后大量自主编辑 → 高采纳 + 高自主修改 + 高编辑比
		scores.Optimizer = metrics.adoptionRate * 0.3 + metrics.selfModificationRate * 0.35 + metrics.codeEditRatio * 0.35

		// ---- Debugger（调试型）----
		// 调试频率高为主要信号，辅以中等轮次
		scores.Debugger =
			metrics.debuggingFrequency * 0.6 +
			this.sigmoid(metrics.avgTurnsPerTask, 3, 1) * 0.2 +
			(metrics.dominantCategory === "debugging" ? 0.2 : 0)

		// ---- Balanced（均衡型）----
		// 所有指标都在中间区间时得分高
		const midnessSum =
			this.midness(metrics.aiDependencyScore) +
			this.midness(metrics.codeEditRatio) +
			this.midness(metrics.adoptionRate) +
			this.midness(metrics.selfModificationRate)
		scores.Balanced = midnessSum / 4

		// 选出最高分
		let bestStyle: LearningStyle = "Balanced"
		let bestScore = 0
		for (const [style, score] of Object.entries(scores) as [LearningStyle, number][]) {
			if (score > bestScore) {
				bestScore = score
				bestStyle = style
			}
		}

		// 置信度：最高分与第二高分的差距 + 绝对值
		const sortedScores = Object.values(scores).sort((a, b) => b - a)
		const gap = sortedScores.length > 1 ? sortedScores[0] - sortedScores[1] : sortedScores[0]
		const confidence = Math.min(bestScore * 0.6 + gap * 0.4, 1)

		// 如果最高得分太低，回退 Balanced
		if (bestScore < 0.3) {
			return { style: "Balanced", confidence: bestScore }
		}

		return { style: bestStyle, confidence: parseFloat(confidence.toFixed(3)) }
	}

	// ===================== 辅助函数 =====================

	/**
	 * Sigmoid 平滑阈值函数
	 * 在 center 附近从 0 → 1 过渡，steepness 控制陡峭程度。
	 */
	private sigmoid(x: number, center: number, steepness: number): number {
		return 1 / (1 + Math.exp(-steepness * (x - center)))
	}

	/**
	 * "中间度"函数，值越接近 0.5 返回越高（最大 1），偏向两端返回越低。
	 * 用于 Balanced 风格打分。
	 */
	private midness(x: number): number {
		return 1 - 2 * Math.abs(x - 0.5)
	}
}
