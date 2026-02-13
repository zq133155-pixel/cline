#!/usr/bin/env ts-node
/**
 * 学生交互日志离线分析脚本
 * Student Interaction Log Offline Analysis Script
 *
 * 用法:
 *   npx ts-node scripts/analyze-student-log.ts [logPath]
 *
 * 参数:
 *   logPath - 可选，日志文件路径。默认为当前目录下的 .cline-logs/student_interactions.log
 *
 * 输出:
 *   - 总任务数
 *   - 各 category 数量分布
 *   - 平均输入长度
 *   - 代码包含率
 *   - 语言分布
 */

import * as fs from "fs"
import * as path from "path"

// ============= 类型定义（与 src/core/task/student-analytics/types.ts 保持一致） =============

type TaskCategory =
	| "algorithm"
	| "debugging"
	| "explanation"
	| "language_request"
	| "code_generation"
	| "refactoring"
	| "testing"
	| "other"

type LanguageHint = "cpp" | "python" | "java" | "javascript" | "typescript" | "c" | "unknown"

type LogEventType = "task_start" | "turn_message" | "code_edit" | "file_save" | "adoption_infer"

type SuggestionType = "code_generation" | "code_edit" | "explanation" | "question" | "completion" | "command" | "mixed" | "other"

type AdoptionStatus = "adopted" | "rejected" | "continued" | "unknown"

interface StudentInteractionLog {
	ts: string
	taskId: string
	eventType: LogEventType
	role?: string
	category: TaskCategory
	contentLength: number
	hasCode: boolean
	languageHint: LanguageHint
	imageCount: number
	fileCount: number
	turnIndex: number
	rawContent?: string
	// 2.0 新增字段
	suggestionType?: SuggestionType
	toolsUsed?: string[]
	filePath?: string
	changeDelta?: number
	adoptionStatus?: AdoptionStatus
}

interface AnalysisResult {
	totalTasks: number
	uniqueTaskIds: number
	categoryDistribution: Record<string, number>
	averageContentLength: number
	codeInclusionRate: number
	languageDistribution: Record<string, number>
	timeRange: {
		start: string
		end: string
	}
	imageUsageRate: number
	fileUsageRate: number
	averageTurnsPerTask: number
	// 2.0 新增统计指标
	assistantOutputRatio: number // AI 输出占比
	codeGenerationRatio: number // 代码生成比例
	codeEditRate: number // 代码编辑率（有编辑行为的任务比例）
	adoptionRate: number // AI 建议采纳率
	averageChainLength: number // 平均每任务完整链条长度
	suggestionTypeDistribution: Record<string, number> // 建议类型分布
	toolUsageDistribution: Record<string, number> // 工具使用分布
	totalAssistantTurns: number // AI 回复总数
	totalUserTurns: number // 用户消息总数
	totalCodeEdits: number // 代码编辑总数
	totalFileSaves: number // 文件保存总数
}

// ============= 分析函数 =============

function readLogs(logPath: string): StudentInteractionLog[] {
	if (!fs.existsSync(logPath)) {
		console.error(`❌ 日志文件不存在: ${logPath}`)
		process.exit(1)
	}

	const content = fs.readFileSync(logPath, "utf8")
	const lines = content.trim().split("\n").filter(Boolean)

	const logs: StudentInteractionLog[] = []
	let parseErrors = 0

	for (let i = 0; i < lines.length; i++) {
		try {
			const log = JSON.parse(lines[i]) as StudentInteractionLog
			logs.push(log)
		} catch (_error) {
			parseErrors++
			console.warn(`⚠️ 第 ${i + 1} 行解析失败，已跳过`)
		}
	}

	if (parseErrors > 0) {
		console.warn(`\n⚠️ 共有 ${parseErrors} 行解析失败\n`)
	}

	return logs
}

function analyzeLogs(logs: StudentInteractionLog[]): AnalysisResult {
	if (logs.length === 0) {
		return {
			totalTasks: 0,
			uniqueTaskIds: 0,
			categoryDistribution: {},
			averageContentLength: 0,
			codeInclusionRate: 0,
			languageDistribution: {},
			timeRange: { start: "", end: "" },
			imageUsageRate: 0,
			fileUsageRate: 0,
			averageTurnsPerTask: 0,
			assistantOutputRatio: 0,
			codeGenerationRatio: 0,
			codeEditRate: 0,
			adoptionRate: 0,
			averageChainLength: 0,
			suggestionTypeDistribution: {},
			toolUsageDistribution: {},
			totalAssistantTurns: 0,
			totalUserTurns: 0,
			totalCodeEdits: 0,
			totalFileSaves: 0,
		}
	}

	// === 基础统计（兼容 1.0） ===

	// 统计唯一任务ID
	const uniqueTaskIds = new Set(logs.map((log) => log.taskId))

	// 分类分布（仅对话消息，不含 code_edit/file_save）
	const conversationLogs = logs.filter((l) => l.eventType === "task_start" || l.eventType === "turn_message")
	const categoryDistribution: Record<string, number> = {}
	for (const log of conversationLogs) {
		const cat = log.category || "unknown"
		categoryDistribution[cat] = (categoryDistribution[cat] || 0) + 1
	}

	// 平均内容长度（仅对话消息）
	const totalContentLength = conversationLogs.reduce((sum, log) => sum + (log.contentLength || 0), 0)
	const averageContentLength = conversationLogs.length > 0 ? totalContentLength / conversationLogs.length : 0

	// 代码包含率（仅对话消息）
	const logsWithCode = conversationLogs.filter((log) => log.hasCode).length
	const codeInclusionRate = conversationLogs.length > 0 ? logsWithCode / conversationLogs.length : 0

	// 语言分布
	const languageDistribution: Record<string, number> = {}
	for (const log of conversationLogs) {
		const lang = log.languageHint || "unknown"
		languageDistribution[lang] = (languageDistribution[lang] || 0) + 1
	}

	// 时间范围
	const timestamps = logs
		.map((log) => log.ts)
		.filter(Boolean)
		.sort()
	const timeRange = {
		start: timestamps[0] || "",
		end: timestamps[timestamps.length - 1] || "",
	}

	// 图片使用率
	const logsWithImages = conversationLogs.filter((log) => (log.imageCount || 0) > 0).length
	const imageUsageRate = conversationLogs.length > 0 ? logsWithImages / conversationLogs.length : 0

	// 文件使用率
	const logsWithFiles = conversationLogs.filter((log) => (log.fileCount || 0) > 0).length
	const fileUsageRate = conversationLogs.length > 0 ? logsWithFiles / conversationLogs.length : 0

	// 平均每个任务的轮次数
	const taskTurnCounts = new Map<string, number>()
	for (const log of conversationLogs) {
		const current = taskTurnCounts.get(log.taskId) || 0
		taskTurnCounts.set(log.taskId, Math.max(current, (log.turnIndex || 0) + 1))
	}
	const totalTurns = Array.from(taskTurnCounts.values()).reduce((sum, count) => sum + count, 0)
	const averageTurnsPerTask = uniqueTaskIds.size > 0 ? totalTurns / uniqueTaskIds.size : 0

	// === 2.0 新增统计 ===

	// 按角色分类
	const userTurns = conversationLogs.filter((l) => l.role === "user")
	const assistantTurns = conversationLogs.filter((l) => l.role === "assistant")
	const codeEdits = logs.filter((l) => l.eventType === "code_edit")
	const fileSaves = logs.filter((l) => l.eventType === "file_save")

	// 1️⃣ AI 输出占比：assistant 消息数 / 对话消息总数
	const assistantOutputRatio = conversationLogs.length > 0 ? assistantTurns.length / conversationLogs.length : 0

	// 2️⃣ 代码生成比例：AI 回复中包含代码的比例
	const assistantWithCode = assistantTurns.filter((l) => l.hasCode).length
	const codeGenerationRatio = assistantTurns.length > 0 ? assistantWithCode / assistantTurns.length : 0

	// 3️⃣ 代码编辑率：有编辑行为的任务 / 总任务数
	const tasksWithCodeEdit = new Set(codeEdits.map((l) => l.taskId))
	const codeEditRate = uniqueTaskIds.size > 0 ? tasksWithCodeEdit.size / uniqueTaskIds.size : 0

	// 4️⃣ AI 建议采纳率：基于 adoption_infer 事件
	const adoptionInferLogs = logs.filter((l) => l.eventType === "adoption_infer")
	const turnsWithAdoption = adoptionInferLogs.filter((l) => l.adoptionStatus && l.adoptionStatus !== "unknown")
	const adoptedTurns = turnsWithAdoption.filter((l) => l.adoptionStatus === "adopted")
	const adoptionRate = turnsWithAdoption.length > 0 ? adoptedTurns.length / turnsWithAdoption.length : 0

	// 5️⃣ 平均每任务完整链条长度
	// 链条：用户消息 + AI 回复 + 代码编辑 + 文件保存 = 一个 task 内的所有事件
	const taskEventCounts = new Map<string, number>()
	for (const log of logs) {
		taskEventCounts.set(log.taskId, (taskEventCounts.get(log.taskId) || 0) + 1)
	}
	const totalEvents = Array.from(taskEventCounts.values()).reduce((sum, count) => sum + count, 0)
	const averageChainLength = uniqueTaskIds.size > 0 ? totalEvents / uniqueTaskIds.size : 0

	// 建议类型分布
	const suggestionTypeDistribution: Record<string, number> = {}
	for (const log of assistantTurns) {
		const st = log.suggestionType || "unknown"
		suggestionTypeDistribution[st] = (suggestionTypeDistribution[st] || 0) + 1
	}

	// 工具使用分布
	const toolUsageDistribution: Record<string, number> = {}
	for (const log of assistantTurns) {
		if (log.toolsUsed) {
			for (const tool of log.toolsUsed) {
				toolUsageDistribution[tool] = (toolUsageDistribution[tool] || 0) + 1
			}
		}
	}

	return {
		totalTasks: logs.length,
		uniqueTaskIds: uniqueTaskIds.size,
		categoryDistribution,
		averageContentLength,
		codeInclusionRate,
		languageDistribution,
		timeRange,
		imageUsageRate,
		fileUsageRate,
		averageTurnsPerTask,
		// 2.0 新增
		assistantOutputRatio,
		codeGenerationRatio,
		codeEditRate,
		adoptionRate,
		averageChainLength,
		suggestionTypeDistribution,
		toolUsageDistribution,
		totalAssistantTurns: assistantTurns.length,
		totalUserTurns: userTurns.length,
		totalCodeEdits: codeEdits.length,
		totalFileSaves: fileSaves.length,
	}
}

function formatPercentage(value: number): string {
	return `${(value * 100).toFixed(1)}%`
}

function printReport(result: AnalysisResult): void {
	console.log("\n" + "=".repeat(60))
	console.log("📊 学生编程行为数据分析报告 v2.0")
	console.log("   Student Programming Behavior Analytics Report v2.0")
	console.log("=".repeat(60) + "\n")

	// 基础统计
	console.log("📈 基础统计")
	console.log("-".repeat(40))
	console.log(`   总交互记录数:     ${result.totalTasks}`)
	console.log(`   唯一任务数:       ${result.uniqueTaskIds}`)
	console.log(`   平均输入长度:     ${result.averageContentLength.toFixed(1)} 字符`)
	console.log(`   平均每任务轮次:   ${result.averageTurnsPerTask.toFixed(2)}`)
	console.log()

	// 交互链条统计（2.0 新增）
	console.log("🔗 交互链条统计 (Interaction Chain)")
	console.log("-".repeat(40))
	console.log(`   用户消息总数:     ${result.totalUserTurns}`)
	console.log(`   AI 回复总数:      ${result.totalAssistantTurns}`)
	console.log(`   代码编辑次数:     ${result.totalCodeEdits}`)
	console.log(`   文件保存次数:     ${result.totalFileSaves}`)
	console.log(`   平均链条长度:     ${result.averageChainLength.toFixed(2)} 事件/任务`)
	console.log()

	// AI 输出分析（2.0 新增）
	console.log("🤖 AI 输出分析 (AI Output Analysis)")
	console.log("-".repeat(40))
	console.log(`   AI 输出占比:      ${formatPercentage(result.assistantOutputRatio)}`)
	console.log(`   代码生成比例:     ${formatPercentage(result.codeGenerationRatio)}`)
	console.log(`   代码编辑率:       ${formatPercentage(result.codeEditRate)}`)
	console.log(`   AI 建议采纳率:    ${formatPercentage(result.adoptionRate)}`)
	console.log()

	// 建议类型分布（2.0 新增）
	const suggestionTypes = Object.entries(result.suggestionTypeDistribution).sort((a, b) => b[1] - a[1])
	if (suggestionTypes.length > 0) {
		const totalSuggestions = suggestionTypes.reduce((sum, [, count]) => sum + count, 0)
		console.log("💡 AI 建议类型分布 (Suggestion Type Distribution)")
		console.log("-".repeat(40))
		for (const [type, count] of suggestionTypes) {
			const percentage = formatPercentage(count / totalSuggestions)
			const bar = "█".repeat(Math.ceil((count / totalSuggestions) * 30))
			console.log(`   ${type.padEnd(18)} ${String(count).padStart(5)}  ${percentage.padStart(6)}  ${bar}`)
		}
		console.log()
	}

	// 工具使用分布（2.0 新增）
	const toolUsages = Object.entries(result.toolUsageDistribution).sort((a, b) => b[1] - a[1])
	if (toolUsages.length > 0) {
		const totalToolUses = toolUsages.reduce((sum, [, count]) => sum + count, 0)
		console.log("🔧 AI 工具使用分布 (Tool Usage Distribution)")
		console.log("-".repeat(40))
		for (const [tool, count] of toolUsages) {
			const percentage = formatPercentage(count / totalToolUses)
			const bar = "█".repeat(Math.ceil((count / totalToolUses) * 30))
			console.log(`   ${tool.padEnd(24)} ${String(count).padStart(5)}  ${percentage.padStart(6)}  ${bar}`)
		}
		console.log()
	}

	// 时间范围
	if (result.timeRange.start && result.timeRange.end) {
		console.log("⏰ 时间范围")
		console.log("-".repeat(40))
		console.log(`   开始时间: ${result.timeRange.start}`)
		console.log(`   结束时间: ${result.timeRange.end}`)
		console.log()
	}

	// 分类分布
	console.log("📂 任务分类分布 (Category Distribution)")
	console.log("-".repeat(40))
	const sortedCategories = Object.entries(result.categoryDistribution).sort((a, b) => b[1] - a[1])
	const totalConversation = sortedCategories.reduce((sum, [, count]) => sum + count, 0)

	for (const [category, count] of sortedCategories) {
		const percentage = formatPercentage(totalConversation > 0 ? count / totalConversation : 0)
		const bar = "█".repeat(Math.ceil((totalConversation > 0 ? count / totalConversation : 0) * 30))
		console.log(`   ${category.padEnd(18)} ${String(count).padStart(5)}  ${percentage.padStart(6)}  ${bar}`)
	}
	console.log()

	// 代码相关统计
	console.log("💻 代码相关统计")
	console.log("-".repeat(40))
	console.log(`   代码包含率:       ${formatPercentage(result.codeInclusionRate)}`)
	console.log(`   图片使用率:       ${formatPercentage(result.imageUsageRate)}`)
	console.log(`   文件附带率:       ${formatPercentage(result.fileUsageRate)}`)
	console.log()

	// 语言分布
	console.log("🌐 编程语言分布 (Language Distribution)")
	console.log("-".repeat(40))
	const sortedLanguages = Object.entries(result.languageDistribution).sort((a, b) => b[1] - a[1])
	const totalLangs = sortedLanguages.reduce((sum, [, count]) => sum + count, 0)

	for (const [language, count] of sortedLanguages) {
		const percentage = formatPercentage(totalLangs > 0 ? count / totalLangs : 0)
		const bar = "█".repeat(Math.ceil((totalLangs > 0 ? count / totalLangs : 0) * 30))
		console.log(`   ${language.padEnd(14)} ${String(count).padStart(5)}  ${percentage.padStart(6)}  ${bar}`)
	}
	console.log()

	console.log("=".repeat(60))
	console.log("✅ 分析完成 (v2.0 认知链条闭环采集)")
	console.log("=".repeat(60) + "\n")
}

function exportToJson(result: AnalysisResult, outputPath: string): void {
	const output = {
		generatedAt: new Date().toISOString(),
		...result,
	}
	fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf8")
	console.log(`📁 JSON 报告已导出到: ${outputPath}`)
}

// ============= 主程序 =============

function main(): void {
	const args = process.argv.slice(2)

	// 确定日志文件路径
	let logPath: string
	if (args[0]) {
		logPath = path.resolve(args[0])
	} else {
		// 默认路径：当前目录下的 .cline-logs/student_interactions.log
		logPath = path.join(process.cwd(), ".cline-logs", "student_interactions.log")
	}

	console.log(`\n📖 正在读取日志文件: ${logPath}`)

	// 读取并解析日志
	const logs = readLogs(logPath)
	console.log(`✅ 成功读取 ${logs.length} 条日志记录`)

	// 分析日志
	const result = analyzeLogs(logs)

	// 打印报告
	printReport(result)

	// 可选：导出 JSON
	const exportJson = args.includes("--json") || args.includes("-j")
	if (exportJson) {
		const jsonOutputPath = logPath.replace(/\.log$/, "_analysis.json")
		exportToJson(result, jsonOutputPath)
	}
}

// 运行主程序
main()
