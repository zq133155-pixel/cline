#!/usr/bin/env ts-node
/**
 * 干预效果离线统计分析脚本
 * Intervention Effect Offline Analysis Script
 *
 * 用法:
 *   npx ts-node scripts/analyze-intervention-effect.ts [logPath]
 *   npx ts-node scripts/analyze-intervention-effect.ts [logPath] --json
 *   npx ts-node scripts/analyze-intervention-effect.ts [logPath] --verbose
 *
 * 参数:
 *   logPath   - 可选，日志文件路径。默认为 .cline-logs/student_interactions.log
 *   --json    - 导出 JSON 报告
 *   --verbose - 打印每条评估记录的详细信息
 *
 * 输出:
 *   - 干预总数 / 评估覆盖率
 *   - 改善 / 中立 / 无效 的分布
 *   - 按规则 / 严重等级 / 风格的分维度统计
 *   - 行为改善分数统计（均值、中位数、分布）
 *   - 每条评估记录明细（--verbose）
 */

import * as fs from "fs"
import * as path from "path"

// ======================== 类型定义 ========================

type BehaviorRuleId = "consecutive_code_generation" | "no_edit_streak" | "ai_dependency_ratio" | "low_self_modification"
type InterventionSeverity = "gentle" | "moderate" | "strong"
type InterventionStyle = "hint" | "question" | "encouragement" | "example"
type EvaluationOutcome = "improved" | "neutral" | "no_effect"

interface BehaviorSnapshot {
	ts: string
	assistantCodeStreak: number
	turnsSinceLastEdit: number
	codeEditCount: number
	assistantCodeTurnCount: number
	userTurnCount: number
	turnIndex: number
}

interface BehaviorDelta {
	codeStreakDelta: number
	noEditStreakDelta: number
	codeEditDelta: number
	userTurnDelta: number
	improvementScore: number
}

/** rawContent 中解析出来的评估数据 */
interface EvaluationData {
	sessionId: string
	ruleId: BehaviorRuleId
	severity: InterventionSeverity
	style: InterventionStyle
	outcome: EvaluationOutcome
	confidence: number
	preSnapshot: BehaviorSnapshot
	postSnapshot: BehaviorSnapshot
	behaviorDelta: BehaviorDelta
	observedEventCount: number
	evaluationDurationMs: number
}

/** 从 JSONL 中读出的日志行 */
interface LogEntry {
	ts: string
	taskId: string
	eventType: string
	rawContent?: string
	[key: string]: unknown
}

/** 完整的评估记录 - 合并日志元数据和评估数据 */
interface EvaluationRecord extends EvaluationData {
	ts: string
	taskId: string
}

// ======================== 统计结果类型 ========================

interface OverallStats {
	totalEvaluations: number
	totalTasks: number
	outcomeDistribution: Record<EvaluationOutcome, number>
	successRate: number // improved / total
	averageConfidence: number
	averageImprovementScore: number
	medianImprovementScore: number
	scoreDistribution: {
		strongImproved: number // score >= 0.5
		improved: number // 0.25 <= score < 0.5
		neutral: number // -0.1 < score < 0.25
		noEffect: number // score <= -0.1
	}
	averageDurationMs: number
	averageObservedEvents: number
}

interface RuleStats {
	ruleId: BehaviorRuleId
	count: number
	outcomes: Record<EvaluationOutcome, number>
	successRate: number
	avgScore: number
	avgConfidence: number
}

interface SeverityStats {
	severity: InterventionSeverity
	count: number
	outcomes: Record<EvaluationOutcome, number>
	successRate: number
	avgScore: number
}

interface StyleStats {
	style: InterventionStyle
	count: number
	outcomes: Record<EvaluationOutcome, number>
	successRate: number
	avgScore: number
}

interface BehaviorChangeStats {
	avgCodeStreakDelta: number
	avgNoEditStreakDelta: number
	avgCodeEditDelta: number
	avgUserTurnDelta: number
}

interface FullReport {
	generatedAt: string
	logPath: string
	overall: OverallStats
	byRule: RuleStats[]
	bySeverity: SeverityStats[]
	byStyle: StyleStats[]
	behaviorChange: BehaviorChangeStats
	records: EvaluationRecord[]
}

// ======================== 解析函数 ========================

function readLogs(logPath: string): LogEntry[] {
	if (!fs.existsSync(logPath)) {
		console.error(`❌ 日志文件不存在: ${logPath}`)
		process.exit(1)
	}

	const content = fs.readFileSync(logPath, "utf8")
	const lines = content.trim().split("\n").filter(Boolean)
	const logs: LogEntry[] = []
	let parseErrors = 0

	for (let i = 0; i < lines.length; i++) {
		try {
			logs.push(JSON.parse(lines[i]) as LogEntry)
		} catch {
			parseErrors++
		}
	}

	if (parseErrors > 0) {
		console.warn(`⚠️ ${parseErrors} 行解析失败，已跳过`)
	}

	return logs
}

function extractEvaluationRecords(logs: LogEntry[]): EvaluationRecord[] {
	const records: EvaluationRecord[] = []

	for (const log of logs) {
		if (log.eventType !== "intervention_evaluation" || !log.rawContent) {
			continue
		}

		try {
			const data = JSON.parse(log.rawContent as string) as EvaluationData
			records.push({
				ts: log.ts,
				taskId: log.taskId,
				...data,
			})
		} catch {
			console.warn(`⚠️ 评估记录 rawContent 解析失败: ts=${log.ts}`)
		}
	}

	return records
}

// ======================== 统计函数 ========================

function median(arr: number[]): number {
	if (arr.length === 0) return 0
	const sorted = [...arr].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function computeOverallStats(records: EvaluationRecord[]): OverallStats {
	if (records.length === 0) {
		return {
			totalEvaluations: 0,
			totalTasks: 0,
			outcomeDistribution: { improved: 0, neutral: 0, no_effect: 0 },
			successRate: 0,
			averageConfidence: 0,
			averageImprovementScore: 0,
			medianImprovementScore: 0,
			scoreDistribution: { strongImproved: 0, improved: 0, neutral: 0, noEffect: 0 },
			averageDurationMs: 0,
			averageObservedEvents: 0,
		}
	}

	const outcomes: Record<EvaluationOutcome, number> = { improved: 0, neutral: 0, no_effect: 0 }
	const scores: number[] = []
	let totalConfidence = 0
	let totalDuration = 0
	let totalObserved = 0

	const taskIds = new Set<string>()
	const scoreDist = { strongImproved: 0, improved: 0, neutral: 0, noEffect: 0 }

	for (const r of records) {
		outcomes[r.outcome]++
		taskIds.add(r.taskId)
		scores.push(r.behaviorDelta.improvementScore)
		totalConfidence += r.confidence
		totalDuration += r.evaluationDurationMs
		totalObserved += r.observedEventCount

		const s = r.behaviorDelta.improvementScore
		if (s >= 0.5) scoreDist.strongImproved++
		else if (s >= 0.25) scoreDist.improved++
		else if (s > -0.1) scoreDist.neutral++
		else scoreDist.noEffect++
	}

	return {
		totalEvaluations: records.length,
		totalTasks: taskIds.size,
		outcomeDistribution: outcomes,
		successRate: records.length > 0 ? outcomes.improved / records.length : 0,
		averageConfidence: totalConfidence / records.length,
		averageImprovementScore: scores.reduce((a, b) => a + b, 0) / scores.length,
		medianImprovementScore: median(scores),
		scoreDistribution: scoreDist,
		averageDurationMs: totalDuration / records.length,
		averageObservedEvents: totalObserved / records.length,
	}
}

function computeByRule(records: EvaluationRecord[]): RuleStats[] {
	const groups = new Map<BehaviorRuleId, EvaluationRecord[]>()
	for (const r of records) {
		const list = groups.get(r.ruleId) || []
		list.push(r)
		groups.set(r.ruleId, list)
	}

	const result: RuleStats[] = []
	for (const [ruleId, list] of groups) {
		const outcomes: Record<EvaluationOutcome, number> = { improved: 0, neutral: 0, no_effect: 0 }
		let totalScore = 0
		let totalConf = 0
		for (const r of list) {
			outcomes[r.outcome]++
			totalScore += r.behaviorDelta.improvementScore
			totalConf += r.confidence
		}
		result.push({
			ruleId,
			count: list.length,
			outcomes,
			successRate: list.length > 0 ? outcomes.improved / list.length : 0,
			avgScore: totalScore / list.length,
			avgConfidence: totalConf / list.length,
		})
	}

	return result.sort((a, b) => b.count - a.count)
}

function computeBySeverity(records: EvaluationRecord[]): SeverityStats[] {
	const groups = new Map<InterventionSeverity, EvaluationRecord[]>()
	for (const r of records) {
		const list = groups.get(r.severity) || []
		list.push(r)
		groups.set(r.severity, list)
	}

	const result: SeverityStats[] = []
	for (const [severity, list] of groups) {
		const outcomes: Record<EvaluationOutcome, number> = { improved: 0, neutral: 0, no_effect: 0 }
		let totalScore = 0
		for (const r of list) {
			outcomes[r.outcome]++
			totalScore += r.behaviorDelta.improvementScore
		}
		result.push({
			severity,
			count: list.length,
			outcomes,
			successRate: list.length > 0 ? outcomes.improved / list.length : 0,
			avgScore: totalScore / list.length,
		})
	}

	return result.sort((a, b) => b.count - a.count)
}

function computeByStyle(records: EvaluationRecord[]): StyleStats[] {
	const groups = new Map<InterventionStyle, EvaluationRecord[]>()
	for (const r of records) {
		const list = groups.get(r.style) || []
		list.push(r)
		groups.set(r.style, list)
	}

	const result: StyleStats[] = []
	for (const [style, list] of groups) {
		const outcomes: Record<EvaluationOutcome, number> = { improved: 0, neutral: 0, no_effect: 0 }
		let totalScore = 0
		for (const r of list) {
			outcomes[r.outcome]++
			totalScore += r.behaviorDelta.improvementScore
		}
		result.push({
			style,
			count: list.length,
			outcomes,
			successRate: list.length > 0 ? outcomes.improved / list.length : 0,
			avgScore: totalScore / list.length,
		})
	}

	return result.sort((a, b) => b.count - a.count)
}

function computeBehaviorChange(records: EvaluationRecord[]): BehaviorChangeStats {
	if (records.length === 0) {
		return { avgCodeStreakDelta: 0, avgNoEditStreakDelta: 0, avgCodeEditDelta: 0, avgUserTurnDelta: 0 }
	}

	let csTotal = 0,
		neTotal = 0,
		ceTotal = 0,
		utTotal = 0
	for (const r of records) {
		csTotal += r.behaviorDelta.codeStreakDelta
		neTotal += r.behaviorDelta.noEditStreakDelta
		ceTotal += r.behaviorDelta.codeEditDelta
		utTotal += r.behaviorDelta.userTurnDelta
	}

	return {
		avgCodeStreakDelta: csTotal / records.length,
		avgNoEditStreakDelta: neTotal / records.length,
		avgCodeEditDelta: ceTotal / records.length,
		avgUserTurnDelta: utTotal / records.length,
	}
}

// ======================== 格式化输出 ========================

const RULE_LABELS: Record<BehaviorRuleId, string> = {
	consecutive_code_generation: "连续代码生成",
	no_edit_streak: "持续无编辑",
	ai_dependency_ratio: "AI依赖过高",
	low_self_modification: "自主修改不足",
}

const SEVERITY_LABELS: Record<InterventionSeverity, string> = {
	gentle: "温和",
	moderate: "中等",
	strong: "强烈",
}

const STYLE_LABELS: Record<InterventionStyle, string> = {
	hint: "提示",
	question: "引导提问",
	encouragement: "鼓励",
	example: "示例",
}

const OUTCOME_LABELS: Record<EvaluationOutcome, string> = {
	improved: "✅ 改善",
	neutral: "➖ 中立",
	no_effect: "❌ 无效",
}

const OUTCOME_ICONS: Record<EvaluationOutcome, string> = {
	improved: "✅",
	neutral: "➖",
	no_effect: "❌",
}

function pct(n: number, d: number): string {
	return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "N/A"
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
	return `${(ms / 60000).toFixed(1)}min`
}

function scoreBar(score: number): string {
	// -1 到 1 映射到 0-20 的 bar
	const normalized = (score + 1) / 2 // 0 to 1
	const filled = Math.round(normalized * 20)
	const mid = 10 // score=0 的位置
	let bar = ""
	for (let i = 0; i < 20; i++) {
		if (i === mid) bar += "|"
		bar += i < filled ? "█" : "░"
	}
	return bar
}

function printReport(report: FullReport, verbose: boolean): void {
	const { overall } = report

	console.log("\n" + "=".repeat(64))
	console.log("📊 教学干预效果评估报告")
	console.log("   Intervention Effect Evaluation Report")
	console.log("=".repeat(64) + "\n")

	if (overall.totalEvaluations === 0) {
		console.log("⚠️  未找到任何干预评估记录（eventType = intervention_evaluation）")
		console.log("    请先使用 Cline 触发教学干预，并完成对话后再运行本脚本。\n")
		return
	}

	// ---- 总体概览 ----
	console.log("📈 总体概览")
	console.log("-".repeat(44))
	console.log(`   评估记录数:       ${overall.totalEvaluations}`)
	console.log(`   涉及任务数:       ${overall.totalTasks}`)
	console.log(`   平均置信度:       ${(overall.averageConfidence * 100).toFixed(1)}%`)
	console.log(`   平均观察事件:     ${overall.averageObservedEvents.toFixed(1)} 条`)
	console.log(`   平均评估耗时:     ${formatDuration(overall.averageDurationMs)}`)
	console.log()

	// ---- 效果分布 ----
	console.log("🎯 干预效果分布")
	console.log("-".repeat(44))
	const total = overall.totalEvaluations
	for (const outcome of ["improved", "neutral", "no_effect"] as EvaluationOutcome[]) {
		const n = overall.outcomeDistribution[outcome]
		const bar = "█".repeat(Math.ceil((n / total) * 30))
		console.log(`   ${OUTCOME_LABELS[outcome].padEnd(10)} ${String(n).padStart(4)}  ${pct(n, total).padStart(6)}  ${bar}`)
	}
	console.log()
	console.log(`   🏆 干预成功率:    ${pct(overall.outcomeDistribution.improved, total)}`)
	console.log()

	// ---- 改善分数统计 ----
	console.log("📐 改善分数统计 (improvementScore)")
	console.log("-".repeat(44))
	console.log(`   平均值:           ${overall.averageImprovementScore.toFixed(3)}`)
	console.log(`   中位数:           ${overall.medianImprovementScore.toFixed(3)}`)
	console.log(`   分数分布:`)
	const sd = overall.scoreDistribution
	console.log(`     强改善 (≥0.5):  ${String(sd.strongImproved).padStart(4)}  ${pct(sd.strongImproved, total).padStart(6)}`)
	console.log(`     改善 (0.25~0.5):${String(sd.improved).padStart(4)}  ${pct(sd.improved, total).padStart(6)}`)
	console.log(`     中立 (-0.1~0.25):${String(sd.neutral).padStart(3)}  ${pct(sd.neutral, total).padStart(6)}`)
	console.log(`     无效 (≤-0.1):   ${String(sd.noEffect).padStart(4)}  ${pct(sd.noEffect, total).padStart(6)}`)
	console.log()

	// ---- 按规则维度 ----
	if (report.byRule.length > 0) {
		console.log("📋 按触发规则统计")
		console.log("-".repeat(44))
		for (const rs of report.byRule) {
			const label = RULE_LABELS[rs.ruleId] || rs.ruleId
			console.log(`   ${label} (${rs.ruleId})`)
			console.log(
				`     次数: ${rs.count}  |  成功率: ${pct(rs.outcomes.improved, rs.count)}  |  平均分: ${rs.avgScore.toFixed(3)}  |  置信度: ${(rs.avgConfidence * 100).toFixed(1)}%`,
			)
			console.log(`     ✅${rs.outcomes.improved}  ➖${rs.outcomes.neutral}  ❌${rs.outcomes.no_effect}`)
			console.log()
		}
	}

	// ---- 按严重等级 ----
	if (report.bySeverity.length > 0) {
		console.log("⚡ 按干预强度统计")
		console.log("-".repeat(44))
		for (const ss of report.bySeverity) {
			const label = SEVERITY_LABELS[ss.severity] || ss.severity
			console.log(
				`   ${label.padEnd(4)}(${ss.severity.padEnd(8)})  次数: ${String(ss.count).padStart(3)}  成功率: ${pct(ss.outcomes.improved, ss.count).padStart(6)}  平均分: ${ss.avgScore.toFixed(3)}`,
			)
		}
		console.log()
	}

	// ---- 按风格 ----
	if (report.byStyle.length > 0) {
		console.log("🎨 按干预风格统计")
		console.log("-".repeat(44))
		for (const st of report.byStyle) {
			const label = STYLE_LABELS[st.style] || st.style
			console.log(
				`   ${label.padEnd(6)}(${st.style.padEnd(13)})  次数: ${String(st.count).padStart(3)}  成功率: ${pct(st.outcomes.improved, st.count).padStart(6)}  平均分: ${st.avgScore.toFixed(3)}`,
			)
		}
		console.log()
	}

	// ---- 行为变化明细 ----
	const bc = report.behaviorChange
	console.log("🔬 行为指标平均变化量")
	console.log("-".repeat(44))
	console.log(
		`   连续代码生成变化:  ${bc.avgCodeStreakDelta >= 0 ? "+" : ""}${bc.avgCodeStreakDelta.toFixed(2)}  ${bc.avgCodeStreakDelta <= 0 ? "⬇️ 好" : "⬆️ 差"}`,
	)
	console.log(
		`   无编辑轮次变化:    ${bc.avgNoEditStreakDelta >= 0 ? "+" : ""}${bc.avgNoEditStreakDelta.toFixed(2)}  ${bc.avgNoEditStreakDelta <= 0 ? "⬇️ 好" : "⬆️ 差"}`,
	)
	console.log(
		`   代码编辑数变化:    ${bc.avgCodeEditDelta >= 0 ? "+" : ""}${bc.avgCodeEditDelta.toFixed(2)}  ${bc.avgCodeEditDelta >= 0 ? "⬆️ 好" : "⬇️ 差"}`,
	)
	console.log(
		`   用户主动发言变化:  ${bc.avgUserTurnDelta >= 0 ? "+" : ""}${bc.avgUserTurnDelta.toFixed(2)}  ${bc.avgUserTurnDelta >= 0 ? "⬆️ 好" : "⬇️ 差"}`,
	)
	console.log()

	// ---- 结论 ----
	console.log("💡 结论")
	console.log("-".repeat(44))
	const sr = overall.outcomeDistribution.improved / total
	if (sr >= 0.6) {
		console.log("   干预机制整体表现良好，多数干预促成了学生行为改善。")
	} else if (sr >= 0.3) {
		console.log("   干预效果一般，约一半干预起到了作用，建议优化干预策略。")
	} else if (total >= 3) {
		console.log("   干预效果不佳，多数干预未能改变学生行为，需要调整干预规则和内容。")
	} else {
		console.log("   数据量不足以得出可靠结论，建议积累更多干预记录后再分析。")
	}

	// 找出最有效的规则
	const bestRule = report.byRule.reduce<RuleStats | null>((best, r) => {
		if (!best || r.successRate > best.successRate) return r
		return best
	}, null)
	if (bestRule && bestRule.count >= 2) {
		console.log(`   最有效规则: ${RULE_LABELS[bestRule.ruleId]}（成功率 ${pct(bestRule.outcomes.improved, bestRule.count)}）`)
	}

	// 找出最有效的风格
	const bestStyle = report.byStyle.reduce<StyleStats | null>((best, s) => {
		if (!best || s.successRate > best.successRate) return s
		return best
	}, null)
	if (bestStyle && bestStyle.count >= 2) {
		console.log(
			`   最有效风格: ${STYLE_LABELS[bestStyle.style]}（成功率 ${pct(bestStyle.outcomes.improved, bestStyle.count)}）`,
		)
	}

	console.log()

	// ---- 明细表（verbose 模式） ----
	if (verbose) {
		console.log("📝 评估记录明细")
		console.log("=".repeat(64))
		for (let i = 0; i < report.records.length; i++) {
			const r = report.records[i]
			console.log(`\n--- 记录 #${i + 1} ---`)
			console.log(`  时间:     ${r.ts}`)
			console.log(`  任务ID:   ${r.taskId}`)
			console.log(`  会话ID:   ${r.sessionId}`)
			console.log(`  规则:     ${RULE_LABELS[r.ruleId]} (${r.ruleId})`)
			console.log(`  强度:     ${SEVERITY_LABELS[r.severity]}  |  风格: ${STYLE_LABELS[r.style]}`)
			console.log(`  结果:     ${OUTCOME_ICONS[r.outcome]} ${r.outcome}`)
			console.log(
				`  改善分:   ${r.behaviorDelta.improvementScore.toFixed(3)}  ${scoreBar(r.behaviorDelta.improvementScore)}`,
			)
			console.log(`  置信度:   ${(r.confidence * 100).toFixed(1)}%`)
			console.log(`  观察事件: ${r.observedEventCount} 条  |  耗时: ${formatDuration(r.evaluationDurationMs)}`)
			console.log(`  行为变化:`)
			console.log(
				`    连续代码生成: ${r.preSnapshot.assistantCodeStreak} → ${r.postSnapshot.assistantCodeStreak} (Δ${r.behaviorDelta.codeStreakDelta >= 0 ? "+" : ""}${r.behaviorDelta.codeStreakDelta})`,
			)
			console.log(
				`    无编辑轮次:   ${r.preSnapshot.turnsSinceLastEdit} → ${r.postSnapshot.turnsSinceLastEdit} (Δ${r.behaviorDelta.noEditStreakDelta >= 0 ? "+" : ""}${r.behaviorDelta.noEditStreakDelta})`,
			)
			console.log(`    代码编辑数:   +${r.behaviorDelta.codeEditDelta}`)
			console.log(`    用户发言数:   +${r.behaviorDelta.userTurnDelta}`)
		}
		console.log()
	}

	console.log("=".repeat(64))
	console.log(`✅ 分析完成 | 共 ${total} 条评估记录 | ${report.generatedAt}`)
	console.log("=".repeat(64) + "\n")
}

// ======================== 主程序 ========================

function main(): void {
	const args = process.argv.slice(2)
	const flags = args.filter((a) => a.startsWith("--"))
	const positional = args.filter((a) => !a.startsWith("--"))

	const verbose = flags.includes("--verbose") || flags.includes("-v")
	const exportJson = flags.includes("--json") || flags.includes("-j")

	// 确定日志路径
	let logPath: string
	if (positional[0]) {
		logPath = path.resolve(positional[0])
	} else {
		logPath = path.join(process.cwd(), ".cline-logs", "student_interactions.log")
	}

	console.log(`\n📖 正在读取日志文件: ${logPath}`)

	// 读取日志
	const allLogs = readLogs(logPath)
	console.log(`   总日志条数: ${allLogs.length}`)

	// 提取评估记录
	const records = extractEvaluationRecords(allLogs)
	console.log(`   干预评估记录: ${records.length} 条`)

	// 计算关联的干预记录数(通过 turn_message 中的 intervention 事件近似)
	const interventionTurnLogs = allLogs.filter(
		(l) =>
			l.eventType === "turn_message" &&
			l.rawContent &&
			typeof l.rawContent === "string" &&
			l.rawContent.includes("teaching_intervention"),
	)
	if (interventionTurnLogs.length > 0) {
		console.log(`   含干预注入的对话轮: ${interventionTurnLogs.length} 条`)
		if (records.length > 0) {
			console.log(`   评估覆盖率: ${pct(records.length, interventionTurnLogs.length)}`)
		}
	}

	// 统计
	const overall = computeOverallStats(records)
	const byRule = computeByRule(records)
	const bySeverity = computeBySeverity(records)
	const byStyle = computeByStyle(records)
	const behaviorChange = computeBehaviorChange(records)

	const report: FullReport = {
		generatedAt: new Date().toISOString(),
		logPath,
		overall,
		byRule,
		bySeverity,
		byStyle,
		behaviorChange,
		records,
	}

	// 打印报告
	printReport(report, verbose)

	// 导出 JSON
	if (exportJson) {
		const jsonPath = logPath.replace(/\.log$/, "_intervention_analysis.json")
		fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf8")
		console.log(`📁 JSON 报告已导出到: ${jsonPath}\n`)
	}
}

main()
